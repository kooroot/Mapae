import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {isDelegationRevoked} from "@mapae/delegation/revocation";
import {useQuery} from "@tanstack/react-query";
import {useState} from "react";
import type {Hex} from "viem";
import type {SessionGrant} from "../lib/grant";
import {deployment, publicClient} from "../lib/chain-client";
import {RevokeButton} from "../dapp/RevokeButton";

/** The outing permissions this browser signed, each with its on-chain state and a revoke control. */
export function ArcadeRevocations({grants, ko, onRevoked}: {
    grants: SessionGrant[]; ko: boolean; onRevoked: (context: Hex) => void;
}) {
    return <section className="arc-queue-panel arcade-revocations" aria-labelledby="arc-revocations-title">
        <h2 id="arc-revocations-title">{ko ? '내 오락실 승인 기록' : 'My arcade permissions'}{grants.length > 0 && <span className="arc-count">{grants.length}</span>}</h2>
        {grants.length === 0 ? <p>{ko ? "이 브라우저에 남은 외출 승인 기록이 없어요. 외출을 보낼 때 서명한 권한이 여기에 남아요." : "No outing permissions are saved in this browser. Each one you sign to send an outing appears here."}</p> : <p>{ko ? "이 브라우저에 남긴 권한입니다. 지갑 서명으로 GIWA에서 철회할 수 있어요. 철회 전에는 서명한 한도와 만료 시각이 적용됩니다." : "Permissions saved in this browser. Sign with the owner wallet to revoke on GIWA. Until then, each signed cap and expiry still applies."}</p>}
        {grants.map(grant => {
            const root = decodeDelegations(grant.artifact.permissionContext).at(-1);
            return root && <ArcadeRevocation key={grant.artifact.permissionContext} grant={grant} delegation={root} ko={ko} onRevoked={onRevoked} />;
        })}
    </section>;
}

function ArcadeRevocation({grant, delegation, ko, onRevoked}: {
    grant: SessionGrant; delegation: NonNullable<ReturnType<typeof decodeDelegations>[number]>; ko: boolean; onRevoked: (context: Hex) => void;
}) {
    const context = grant.artifact.permissionContext;
    const [confirmedHere, setConfirmedHere] = useState(false);
    const status = useQuery({queryKey: ["arcade-revoked", context], queryFn: () => isDelegationRevoked({
        publicClient, delegationManager: deployment.environment.DelegationManager, delegation,
    }), staleTime: 15_000});
    return <div className="arcade-revocation">
        <p>{grant.name} · {new Date(grant.artifact.createdAt * 1000).toLocaleString(ko ? "ko-KR" : "en-US")} · {context.slice(0, 12)}…</p>
        {status.isSuccess ? <RevokeButton delegation={delegation} permissionContext={context} revoked={confirmedHere || status.data}
            onRevoked={() => {setConfirmedHere(true); onRevoked(context);}} /> :
            <small role="status">{status.isError ? ko ? "온체인 상태를 읽지 못했어요. 새로고침해 주세요." : "Could not read on-chain status. Reload to retry." :
                ko ? "온체인 권한 상태 확인 중…" : "Checking on-chain permission…"}</small>}
    </div>;
}
