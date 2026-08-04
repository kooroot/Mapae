import type {Delegation} from "@metamask/smart-accounts-kit";
import {
    SPONSORED_REVOCATION_GAS,
    buildRevocationUserOperation,
    finalizeRevocationUserOperation,
    readAccountOwner,
    readRevocationNonce,
} from "@mapae/delegation/revocation";
import {redactUrls} from "@mapae/shared";
import {useQuery} from "@tanstack/react-query";
import {useState} from "react";
import {getAddress, isHash, type Hex} from "viem";
import {useAccount, useConnect, useSignTypedData} from "wagmi";
import {chain, deployment, explorerTxUrl, publicSubmitterAvailability, publicClient} from "../lib/config";
import {
    judgeStudioRevokeGate,
    requestSponsoredRevocation,
    studioRevokeButtonLabel,
} from "../lib/revoke";

type RevokeProgress =
    | {phase: "idle"}
    | {phase: "signing"}
    | {phase: "submitting"}
    | {phase: "done"; transaction: string}
    | {phase: "failed"; reason: string};

/**
 * The Studio's owner kill switch, carried by the sponsored public endpoint.
 *
 * The flow mirrors the console's local `RevokeButton`, with the two differences the
 * sponsored path dictates: the operation signs the `SPONSORED_REVOCATION_GAS` profile —
 * the public submitter's fee ceiling is 1% of the self-funded one, because the prefund
 * refunds into the requester's own deposit — and there is no deposit gate, because
 * arming the deposit is exactly what the sponsor does. The sequence that has to hold:
 * the connected wallet is compared against `owner()` before anything is signed (a wrong
 * signer would otherwise surface as an inscrutable refusal), the nonce is read at click
 * time and the operation built from it in one shot, and the wire body comes from the
 * same module the submitter validates with.
 */
export function RevokeButton({
    delegation,
    permissionContext,
    revoked,
    onRevoked,
}: {
    delegation: Delegation;
    /**
     * Forwarded verbatim from the loaded permission, not re-encoded from `delegation` —
     * the submitter takes the root as `decodeDelegations(context).at(-1)`, and a second
     * encoder for a value that already exists is the drift class the EIP-712 domain once
     * cost this repo.
     */
    permissionContext: Hex;
    revoked: boolean;
    onRevoked: () => void;
}) {
    const endpoint = publicSubmitterAvailability();
    const payer = getAddress(delegation.delegator);
    // `useAccount().chainId` rather than `useChainId()`: the latter falls back to the
    // config's first chain while disconnected, so it can never report a mismatch, and a
    // guard that cannot fire is worse than none.
    const {address: connected, chainId: connectedChainId} = useAccount();
    const {connect, connectors, isPending: connecting} = useConnect();
    const {signTypedDataAsync} = useSignTypedData();
    const [progress, setProgress] = useState<RevokeProgress>({phase: "idle"});

    const owner = useQuery({
        queryKey: ["studio-owner", payer],
        queryFn: () => readAccountOwner({publicClient, account: payer}),
        staleTime: Infinity,
    });

    const gate = judgeStudioRevokeGate({
        endpoint: endpoint.kind === "configured" ? endpoint.url : undefined,
        revoked,
        connected,
        connectedChainId,
        expectedChainId: chain.id,
        owner: owner.data,
    });

    async function run(): Promise<void> {
        if (gate.kind !== "ready" || endpoint.kind !== "configured") return;
        try {
            setProgress({phase: "signing"});
            const entryPoint = deployment.environment.EntryPoint;
            const nonce = await readRevocationNonce({publicClient, entryPoint, sender: payer});
            const built = buildRevocationUserOperation({
                delegation,
                entryPoint,
                chainId: chain.id,
                nonce,
                gas: SPONSORED_REVOCATION_GAS,
            });
            const signature = await signTypedDataAsync({
                domain: built.typedData.domain,
                types: built.typedData.types,
                primaryType: "PackedUserOperation",
                message: built.typedData.message,
            });
            const final = finalizeRevocationUserOperation(built, signature as Hex);

            setProgress({phase: "submitting"});
            const result = await requestSponsoredRevocation({
                endpoint: endpoint.url,
                permissionContext,
                packed: final.packed,
                delegation,
            });
            setProgress({phase: "done", transaction: result.transaction ?? ""});
            onRevoked();
        } catch (error) {
            setProgress({phase: "failed", reason: faultLine(error)});
        }
    }

    const busy = progress.phase === "signing" || progress.phase === "submitting";

    return (
        <div className="studio-revoke-action">
            <button
                type="button"
                className="studio-revoke-button"
                disabled={
                    busy || connecting || (gate.kind !== "ready" && gate.kind !== "disconnected")
                }
                onClick={() => {
                    if (gate.kind === "disconnected") {
                        const connector = connectors[0];
                        if (connector) connect({connector});
                        return;
                    }
                    void run();
                }}
            >
                {busy
                    ? progress.phase === "signing"
                        ? "지갑에서 서명 대기 중…"
                        : "회수 제출 중…"
                    : studioRevokeButtonLabel(gate)}
            </button>
            {endpoint.kind === "refused" ? (
                <small className="studio-revoke-note fault">
                    회수 엔드포인트 설정이 잘못되었습니다 — {endpoint.reason}
                </small>
            ) : gate.kind === "wrong-chain" ? (
                <small className="studio-revoke-note">
                    지갑을 GIWA Sepolia(chain {gate.expected})로 전환해 주세요. 현재 chain{" "}
                    {gate.connected}에 연결되어 있습니다.
                </small>
            ) : gate.kind === "wrong-wallet" ? (
                <small className="studio-revoke-note">
                    이 권한의 소유자는 {shortAddress(gate.owner)} 입니다. 연결된{" "}
                    {shortAddress(gate.connected)} 지갑으로는 회수를 서명할 수 없습니다.
                </small>
            ) : gate.kind === "ready" ? (
                <small className="studio-revoke-note">
                    가스는 스폰서가 대납합니다 — 이 지갑에는 GIWA ETH가 필요 없습니다.
                </small>
            ) : null}
            {progress.phase === "failed" ? (
                <small className="studio-revoke-note fault">{progress.reason}</small>
            ) : progress.phase === "done" ? (
                <small className="studio-revoke-note">
                    회수가 온체인에서 확인되었습니다.{" "}
                    {/* Validated, not cast: the hash comes from the server's response body,
                        and it is about to be interpolated into a URL. */}
                    {isHash(progress.transaction) ? (
                        <a href={explorerTxUrl(progress.transaction)} target="_blank" rel="noreferrer">
                            트랜잭션 보기
                        </a>
                    ) : null}
                </small>
            ) : null}
        </div>
    );
}

function shortAddress(value: string): string {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * `redactUrls` is not optional here. viem embeds the whole transport URL in every error it
 * raises, a private GIWA endpoint carries its API key in the URL *path*, and this string
 * is rendered straight into the DOM — a sink `check:logging` does not inspect.
 */
function faultLine(error: unknown): string {
    if (error instanceof Error && error.message) return redactUrls(error.message);
    return "요청을 완료하지 못했습니다. 지갑과 네트워크 상태를 확인해 주세요.";
}
