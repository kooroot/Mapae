import {profileRequest} from "./profile/client";
import {PROFILE_GENERATION} from "./profile/model";
import {parseGiwaPending, writeGiwaPending} from "./giwa-store";
import {useEffect, useRef, useState} from "react";
import {useAccount, useConfig, useDisconnect, useSwitchChain} from "wagmi";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {formatUnits, getAddress, type Address, type Hex} from "viem";
import {prepareRootPermissionSigningRequest, assembleRootPermission} from "@mapae/delegation/signing";
import {createMapaeDelegationProvider} from "@mapae/delegation/x402";
import {ARCADE_REDEEMER, ARCADE_TICKET_COST} from "@mapae/arcade/tickets";
import type {GameId} from "@mapae/arcade";
import {bootstrapAvailability, chain, deployment, publicClient} from "../lib/config";
import {derivePayerAccount, readPayerBalance, requestSponsoredBootstrap, verifyPermissionArtifact} from "../lib/grant";
import type {Locale} from "../lib/i18n";
import {arcadePolicy, buyGiwaTicket, checkGiwaCatalogue, GiwaTicketError, hasGiwaTicketTransfer} from "./giwa-client";
import {clearGiwaPending, readGiwaPending, type GiwaPending} from "./giwa-store";
import {giwaWalletError, requestGiwaSignature, waitForWallet} from "./giwa-wallet";
import {loadGrants, writeGrants} from "../lib/grant-store";
import type {SessionGrant} from "../lib/grant";

type Session = {owner: Address; payer: Address; context: Hex; expires: number; remaining: number; provider: ReturnType<typeof createMapaeDelegationProvider>};
export type ApprovalPhase = "idle" | "catalogue" | "wallet" | "switching" | "preparing" | "signing" | "authorizing" | "bootstrap" | "verifying";
export function useGiwaTickets(locale: Locale, profileReady: boolean) {
    const {address, chainId, connector} = useAccount();
    const config = useConfig();
    const {disconnect: disconnectWallet} = useDisconnect();
    const {switchChainAsync} = useSwitchChain();
    const [recoveryReady, setRecoveryReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [phase, setPhase] = useState<ApprovalPhase>("idle");
    const locked = useRef(false), acknowledged = useRef<string | null>(null);
    const [error, setError] = useState("");
    const [remaining, setRemaining] = useState(0);
    const [balance, setBalance] = useState<string | null>(null);
    const [payer, setPayer] = useState<Address | null>(null);
    const [pending, setPending] = useState<GiwaPending | null>(null);
    const [grants, setGrants] = useState<SessionGrant[]>([]);
    const session = useRef<Session | null>(null);
    const activeOwner = useRef(address); activeOwner.current = address;
    const activeConnector = useRef(connector?.uid); activeConnector.current = connector?.uid;
    useEffect(() => () => {activeOwner.current = undefined; session.current = null;}, []);
    useEffect(() => {setGrants(address ? loadGrants().filter(grant => grant.name === "Mapae Arcade") : []);}, [address]);
    useEffect(() => {
        session.current = null; setRemaining(0); setBalance(null); setPayer(null); setError("");
        try {setPending(readGiwaPending());} catch {setError("진행 중인 입장권을 읽을 수 없어요. 새 결제를 멈췄어요. / Pending ticket unavailable.");}
        if (!address) return;
        let cancelled = false;
        void derivePayerAccount(address).then(async account => {
            // A balance RPC failure must not hide a previously signed grant's revoke
            // button. The account address is deterministic and known before that read.
            if (!cancelled) setPayer(account);
            try {
                const value = await readPayerBalance(account);
                if (!cancelled) setBalance(value === undefined ? null : formatUnits(value, 6));
            } catch {
                if (!cancelled) setError("잔액을 읽지 못했어요. 승인 기록은 아래에서 확인할 수 있어요. / Balance unavailable; permissions remain accessible below.");
            }
        }).catch(() => {if (!cancelled) setError("스마트 계정을 확인하지 못했어요. / Account unavailable.");});
        return () => {cancelled = true;};
    }, [address, chainId, connector?.uid]);
    useEffect(() => {
        if (!address || !profileReady || locked.current) return;
        let cancelled = false, loading = false;
        setRecoveryReady(false);
        const reload = () => {
        if (cancelled || loading || locked.current || document.visibilityState === "hidden") return;
        loading = true;
        void profileRequest(address, "/checkout").then(value => {
            if (cancelled || activeOwner.current !== address || locked.current) return;
            const raw = value && typeof value === "object" && "pending" in value ? value.pending : null;
            if (raw && typeof raw === "object") {
                const cloud = parseGiwaPending(JSON.stringify({...raw, header: null}));
                if (cloud.requestId === acknowledged.current) return;
                const local = readGiwaPending();
                const recovered = local?.requestId === cloud.requestId ? {...cloud, header: local.header} : cloud;
                writeGiwaPending(recovered); setPending(recovered);
            } else {clearGiwaPending(); setPending(null);}
            setRecoveryReady(true);
        }).catch(() => {if (!cancelled) setError(locale === "ko" ? "입장권 복구 상태를 확인하지 못했어요. 연결을 확인하고 다시 불러와 주세요." : "Ticket recovery is unavailable. Check your connection and refresh.");}).finally(() => {loading = false;});
        };
        reload(); const poll = setInterval(reload, 30_000);
        window.addEventListener("focus", reload); window.addEventListener("online", reload);
        return () => {cancelled = true; clearInterval(poll); window.removeEventListener("focus", reload); window.removeEventListener("online", reload);};
    }, [address, profileReady]);
    async function approve(admissions: number) {
        if (!address || !connector || locked.current || !recoveryReady) return;
        locked.current = true; setBusy(true); setError("");
        try {
            if (readGiwaPending()) throw new GiwaTicketError("먼저 진행 중인 입장권을 복구해 주세요. / Recover the pending ticket first.");
            const policy = arcadePolicy(admissions);
            setPhase("catalogue");
            await checkGiwaCatalogue();
            setPhase("wallet");
            const walletChain = await waitForWallet(connector.getChainId(), AbortSignal.timeout(20_000));
            if (walletChain !== chain.id) {
                setPhase("switching");
                await waitForWallet(switchChainAsync({chainId: chain.id, connector}), AbortSignal.timeout(90_000));
            }
            setPhase("preparing");
            const owner = getAddress(address);
            const account = await derivePayerAccount(owner);
            const agent = privateKeyToAccount(generatePrivateKey());
            const head = await publicClient.getBlock();
            const startDate = Number(head.timestamp) - 1;
            const signing = prepareRootPermissionSigningRequest({environment: deployment.environment,
                accountOwnerSmartAccount: account, delegate: agent.address, policy, startDate});
            if (activeOwner.current !== address || activeConnector.current !== connector.uid) throw new GiwaTicketError("지갑이 변경됐어요. / Wallet changed.");
            const signature = await requestGiwaSignature({config, connector, owner, typedData: signing.typedData,
                signal: AbortSignal.timeout(90_000), onRequest: () => setPhase("signing")});
            if (activeOwner.current !== address || activeConnector.current !== connector.uid) throw new GiwaTicketError("지갑이 변경됐어요. / Wallet changed.");
            setPhase("authorizing");
            const artifact = assembleRootPermission({role: policy.role, unsignedDelegation: signing.unsignedDelegation, signature, createdAt: startDate});
            await verifyPermissionArtifact(artifact, locale);
            if (activeOwner.current !== address || activeConnector.current !== connector.uid) throw new GiwaTicketError("지갑이 변경됐어요. / Wallet changed.");
            // Keep the public permission context so its owner can still revoke after a
            // reload. The spend-capable agent key is deliberately absent from this store.
            const grant: SessionGrant = {id: `${artifact.createdAt}:${artifact.delegate}:${artifact.permissionContext.slice(-18)}`,
                name: "Mapae Arcade", source: "signed", artifact};
            const savedGrants = writeGrants({add: [grant]});
            setGrants(previous => savedGrants ? savedGrants.filter(item => item.name === "Mapae Arcade") : [grant, ...previous]);
            if (!savedGrants) throw new GiwaTicketError("회수할 권한 기록을 저장하지 못했어요. 이 탭을 닫지 말고 저장 공간을 확인해 주세요. / Could not save the revocation record. Keep this tab open.");
            const sponsor = bootstrapAvailability();
            setPhase("bootstrap");
            if (sponsor.kind === "configured") await requestSponsoredBootstrap(sponsor.url, artifact, locale);
            setPhase("verifying");
            const code = await publicClient.getCode({address: account});
            if (!code || code === "0x") throw new GiwaTicketError("Studio에서 스마트 계정을 준비해 주세요. / Set up your smart account in Studio.");
            await verifyPermissionArtifact(artifact, locale);
            const available = await readPayerBalance(account);
            setPayer(account); setBalance(available === undefined ? null : formatUnits(available, 6));
            if (available === undefined || available < policy.periodAmount) throw new GiwaTicketError("테스트 토큰 잔액이 부족해요. Studio에서 충전해 주세요. / Top up test tokens in Studio.");
            if (activeOwner.current !== address || activeConnector.current !== connector.uid) throw new GiwaTicketError("지갑이 변경됐어요. / Wallet changed.");
            session.current = {owner, payer: account, context: artifact.permissionContext, remaining: admissions, expires: startDate + policy.expiresAfterSeconds,
                provider: createMapaeDelegationProvider({account: agent, environment: deployment.environment,
                    parentPermissionContext: artifact.permissionContext, facilitatorAddresses: [ARCADE_REDEEMER]})};
            setRemaining(admissions);
        } catch (e) {
            // Wallet/provider exceptions can embed signed request data. Only errors
            // created by this UI or the reviewed grant helpers are displayed elsewhere.
            const walletError = giwaWalletError(e);
            const ko = locale === "ko";
            const messages = {
                timeout: ko ? "지갑 응답을 받지 못해 이번 요청을 중단했어요. 지갑의 이전 요청을 거절한 뒤 다시 연결해 주세요. 늦게 온 서명으로 계정을 만들거나 결제하지 않아요." : "Wallet did not respond. Dismiss its previous request and reconnect. A late signature will not deploy an account or pay.",
                pending: ko ? "지갑에 이전 요청이 남아 있어요. 해당 지갑에서 요청을 거절한 뒤 다시 시도해 주세요." : "Your wallet has an earlier request pending. Dismiss it in that wallet before trying again.",
                chain: ko ? "연결한 지갑의 네트워크가 GIWA Sepolia가 아니에요. GIWA로 전환한 뒤 다시 시도해 주세요." : "Your selected wallet is not on GIWA Sepolia. Switch to GIWA and try again.",
                rejected: ko ? "지갑에서 요청을 거절했어요. 이번 요청으로 결제하지 않았어요." : "You declined the wallet request. This request made no payment.",
            };
            setError(walletError ? messages[walletError.code] : e instanceof GiwaTicketError ? e.message : ko ? "용돈 승인이 완료되지 않았어요. 연결한 지갑과 GIWA 네트워크를 확인해 주세요." : "Allowance not approved. Check your selected wallet and GIWA network.");
        } finally {locked.current = false; setBusy(false); setPhase("idle");}
    }
    async function buy(game: GameId, requestId: string, characterId: string) {
        if (locked.current) throw new GiwaTicketError("A GIWA request is already in progress.");
        locked.current = true;
        try {
            const old = readGiwaPending(), current = session.current;
            if (!address || (old && getAddress(old.owner) !== getAddress(address))) throw new GiwaTicketError("입장권 주인의 지갑을 연결해 주세요. / Connect the ticket owner's wallet.");
            if (!old && (!current || current.owner !== getAddress(address) || current.remaining < 1 || current.expires <= Date.now() / 1000)) throw new GiwaTicketError("GIWA 용돈을 먼저 승인해 주세요. / Approve the GIWA allowance first.");
            if (activeOwner.current !== address) throw new GiwaTicketError("Wallet changed.");
            const account = old?.payer ?? current!.payer;
            const receipt = await buyGiwaTicket({game, requestId, characterId, owner: address, payer: account,
                delegationManager: getAddress(deployment.environment.DelegationManager), provider: current?.provider});
            const mined = await publicClient.waitForTransactionReceipt({hash: receipt.transaction, timeout: 30_000}).catch(() => null);
            if (!mined || mined.status !== "success" || !hasGiwaTicketTransfer(mined.logs, account)) {
                throw new GiwaTicketError("GIWA 정산 확인 중이에요. 같은 입장권을 복구해 주세요. / Waiting for the matching on-chain transfer.");
            }
            const value = await readPayerBalance(account);
            if (activeOwner.current !== address) throw new GiwaTicketError("지갑이 변경됐어요. 입장권 주인의 지갑으로 복구해 주세요. / Wallet changed; reconnect the ticket owner.");
            setBalance(value === undefined ? null : formatUnits(value, 6));
            return {...receipt, balanceAfter: value === undefined ? null : formatUnits(value, 6),
                allowanceAfter: current ? (Math.max(0, current.remaining - 1) * ARCADE_TICKET_COST).toFixed(2) : null};
        } finally {
            locked.current = false;
            setPending(readGiwaPending());
        }
    }
    async function acknowledge(): Promise<boolean> {
        if (!address || activeOwner.current !== address) return false;
        const ticket = readGiwaPending();
        if (!ticket || getAddress(ticket.owner) !== getAddress(address)) return false;
        const result = await profileRequest(address, "/checkout/ack", "POST", {generation: PROFILE_GENERATION, requestId: ticket.requestId});
        const admitted = !!result && typeof result === "object" && "admitted" in result && result.admitted === true;
        acknowledged.current = ticket.requestId;
        clearGiwaPending(); setPending(null);
        if (session.current && admitted) {session.current.remaining = Math.max(0, session.current.remaining - 1); setRemaining(session.current.remaining);}
        return admitted;
    }
    function finish() {session.current = null; setRemaining(0);}
    function revoked(context: Hex) {if (session.current?.context === context) finish();}
    function disconnect() {finish(); disconnectWallet();}
    const ownPending = pending && address && getAddress(pending.owner) === getAddress(address) ? pending : null;
    return {address, payer, balance, remaining, recoveryReady, busy, phase, chainId, walletName: connector?.name ?? "", error, pending: ownPending, otherWalletPending: !!pending && !ownPending, grants, revoked, disconnect, approve, buy, acknowledge, finish};
}
