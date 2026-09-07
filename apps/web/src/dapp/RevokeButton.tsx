import type {Delegation} from "@metamask/smart-accounts-kit";
import {
    SPONSORED_REVOCATION_GAS,
    buildRevocationUserOperation,
    finalizeRevocationUserOperation,
    readRevocationNonce,
} from "@mapae/delegation/revocation";
import {redactUrls} from "@mapae/shared";
import {useQuery} from "@tanstack/react-query";
import {useMemo, useState} from "react";
import {getAddress, isHash, type Hex} from "viem";
import {useAccount, useConnect, useSignTypedData} from "wagmi";
import {
    bootstrapAvailability,
    chain,
    deployment,
    explorerTxUrl,
    publicSubmitterAvailability,
    publicClient,
} from "../lib/config";
import type {Locale} from "../lib/i18n";
import {useLocale} from "../lib/locale";
import {
    judgeStudioRevokeGate,
    readPayerAccount,
    requestSponsoredRevocation,
    studioRevokeButtonLabel,
    studioRevokeGateNote,
} from "../lib/revoke";

/** The flow's own copy; what each gate says lives with the gate, in `revoke.ts`. */
const COPY: Record<
    Locale,
    {
        signing: string;
        submitting: string;
        endpointMisconfigured: string;
        confirmed: string;
        viewTransaction: string;
        requestFailed: string;
    }
> = {
    en: {
        signing: "Waiting for the wallet signature…",
        submitting: "Submitting the revocation…",
        endpointMisconfigured: "The revocation endpoint is misconfigured",
        confirmed: "The revocation is confirmed on-chain.",
        viewTransaction: "View transaction",
        requestFailed: "The request could not be completed. Check the wallet and network status.",
    },
    ko: {
        signing: "지갑에서 서명 대기 중…",
        submitting: "회수 제출 중…",
        endpointMisconfigured: "회수 엔드포인트 설정이 잘못되었습니다",
        confirmed: "회수가 온체인에서 확인되었습니다.",
        viewTransaction: "트랜잭션 보기",
        requestFailed: "요청을 완료하지 못했습니다. 지갑과 네트워크 상태를 확인해 주세요.",
    },
};

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
    const {locale} = useLocale();
    const t = COPY[locale];
    const endpoint = publicSubmitterAvailability();
    // Whether the overview tab (`STUDIO_SECTIONS`) shows the top-up button
    // (`FAUCET_COPY.action`) — `TestnetTopUp` renders only with a configured sponsor — so
    // the account-missing note can point there honestly.
    const sponsor = useMemo(() => bootstrapAvailability(), []);
    const payer = getAddress(delegation.delegator);
    // `useAccount().chainId` rather than `useChainId()`: the latter falls back to the
    // config's first chain while disconnected, so it can never report a mismatch, and a
    // guard that cannot fire is worse than none.
    const {address: connected, chainId: connectedChainId} = useAccount();
    const {connect, connectors, isPending: connecting} = useConnect();
    const {signTypedDataAsync} = useSignTypedData();
    const [progress, setProgress] = useState<RevokeProgress>({phase: "idle"});

    // Code first, owner second: a payer nobody deployed yet is a successful read with a
    // verdict of its own, not a failed `owner()` to be diagnosed from an error class.
    const account = useQuery({
        queryKey: ["studio-payer", payer],
        queryFn: () => readPayerAccount({publicClient, account: payer}),
        // A deployed account is final — code stays, and so does its owner. "Not deployed"
        // is the one answer that changes under the user's feet: the note under the button
        // sends them off to have the account deployed, so that answer is stale at once and
        // is read again whenever this button mounts.
        staleTime: (query) => (query.state.data?.deployed ? Infinity : 0),
    });

    const gate = judgeStudioRevokeGate({
        endpoint: endpoint.kind === "configured" ? endpoint.url : undefined,
        revoked,
        connected,
        connectedChainId,
        expectedChainId: chain.id,
        account: account.data,
        accountError: account.error ?? undefined,
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
            const result = await requestSponsoredRevocation(
                {
                    endpoint: endpoint.url,
                    permissionContext,
                    packed: final.packed,
                    delegation,
                },
                locale,
            );
            setProgress({phase: "done", transaction: result.transaction ?? ""});
            onRevoked();
        } catch (error) {
            setProgress({phase: "failed", reason: faultLine(error, locale)});
        }
    }

    const busy = progress.phase === "signing" || progress.phase === "submitting";
    const note = studioRevokeGateNote(gate, locale, {
        topUpOffered: sponsor.kind === "configured",
    });

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
                        ? t.signing
                        : t.submitting
                    : studioRevokeButtonLabel(gate, locale)}
            </button>
            {endpoint.kind === "refused" ? (
                <small className="studio-revoke-note fault">
                    {t.endpointMisconfigured} — {endpoint.reason}
                </small>
            ) : note !== undefined ? (
                <small
                    className={
                        gate.kind === "owner-unreadable"
                            ? "studio-revoke-note fault"
                            : "studio-revoke-note"
                    }
                >
                    {note}
                </small>
            ) : null}
            {progress.phase === "failed" ? (
                <small className="studio-revoke-note fault">{progress.reason}</small>
            ) : progress.phase === "done" ? (
                <small className="studio-revoke-note">
                    {t.confirmed}{" "}
                    {/* Validated, not cast: the hash comes from the server's response body,
                        and it is about to be interpolated into a URL. */}
                    {isHash(progress.transaction) ? (
                        <a href={explorerTxUrl(progress.transaction)} target="_blank" rel="noreferrer">
                            {t.viewTransaction}
                        </a>
                    ) : null}
                </small>
            ) : null}
        </div>
    );
}

/**
 * `redactUrls` is not optional here. viem embeds the whole transport URL in every error it
 * raises, a private GIWA endpoint carries its API key in the URL *path*, and this string
 * is rendered straight into the DOM — a sink `check:logging` does not inspect.
 */
function faultLine(error: unknown, locale: Locale): string {
    if (error instanceof Error && error.message) return redactUrls(error.message);
    return COPY[locale].requestFailed;
}
