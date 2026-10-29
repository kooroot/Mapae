import {ProfileError, profileRequest} from "./profile/client";
import {useEffect, useRef, useState} from "react";
import {useAccount, useConfig, useDisconnect, useSwitchChain} from "wagmi";
import {formatUnits, getAddress, type Address, type Hex} from "viem";
import {ARCADE_TICKET_AMOUNT} from "@mapae/arcade/tickets";
import type {AgentGoal, GameId} from "@mapae/arcade";
import {guardianTokenId} from "@mapae/arcade/guardians";
import {bootstrapAvailability, chain} from "../lib/config";
import {deployment, publicClient} from "../lib/chain-client";
import type {Locale} from "../lib/i18n";
import {arcadePolicy, checkGiwaCatalogue, GiwaTicketError} from "./giwa-client";
import {giwaWalletError, requestGiwaSignature, waitForWallet} from "./giwa-wallet";
import {loadGrants, writeGrants} from "../lib/grant-store";
import type {SessionGrant} from "../lib/grant";
import {validAllowance} from "./allowance";
import {type OutingStatus, type OutingView} from "@mapae/arcade/outings";
import {clearSubmission, readSubmission, saveSubmission, type OutingSubmission} from "./outing-submission";
import {trackEngagement} from './engagement/client';
import {activeGuardianOuting,type GuardianIdentity} from './nft/outing-model';

export type AllowanceRequest = GuardianIdentity & {goal: AgentGoal; name: string; admissions: number};
const isArcadeGrant = (grant: SessionGrant) => grant.name === "Mapae Arcade" || grant.name.startsWith("Mapae Arcade · ");
export type ApprovalPhase = "idle" | "catalogue" | "wallet" | "switching" | "preparing" | "signing" | "authorizing" | "bootstrap" | "verifying" | "submitting";
/** One instance per page: its lock keeps a single approval in flight. `owner` is the gated arcade owner, never a raw connection. */
export function useGiwaTickets(locale: Locale, owner: Address | undefined, authenticated: boolean) {
    const address = owner;
    const {chainId, connector} = useAccount();
    const config = useConfig();
    const {disconnect: disconnectWallet} = useDisconnect();
    const {switchChainAsync} = useSwitchChain();
    const [busy, setBusy] = useState(false);
    const [phase, setPhase] = useState<ApprovalPhase>("idle");
    const locked = useRef(false);
    const [error, setError] = useState("");
    const [jobs, setJobs] = useState<OutingView[]>([]);
    const [available, setAvailable] = useState(false);
    const [submission, setSubmission] = useState<OutingSubmission | null>(null);
    const serverAgent = useRef<Address | null>(null);
    const [approvalTarget, setApprovalTarget] = useState<{name: string; admissions: number; index: number; total: number} | null>(null);
    const [balance, setBalance] = useState<string | null>(null);
    const [payer, setPayer] = useState<Address | null>(null);
    const [grants, setGrants] = useState<SessionGrant[]>([]);
    const activeOwner = useRef(address); activeOwner.current = address;
    const activeConnector = useRef(connector?.uid); activeConnector.current = connector?.uid;
    useEffect(() => () => {activeOwner.current = undefined;}, []);
    useEffect(() => {setGrants(address ? loadGrants().filter(isArcadeGrant) : []);}, [address]);
    useEffect(() => {
        setJobs([]); setSubmission(null); setAvailable(false); serverAgent.current = null; setBalance(null); setPayer(null); setError("");
        if (!address) return;
        try {setSubmission(readSubmission(address));} catch {setError("외출 요청 기록을 읽지 못했어요. / Outing request unavailable.");}
        let cancelled = false;
        void import("../lib/grant").then(async ({derivePayerAccount, readPayerBalance}) => {
            const account = await derivePayerAccount(address);
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
    const refreshing = useRef(false);
    const lastPoll = useRef(0), hasActiveJobs = useRef(false), lastSpent = useRef("");
    const [statusError, setStatusError] = useState("");
    async function refreshOutings() {
        if (!address || !authenticated || refreshing.current) return;
        refreshing.current = true;
        try {
            const value = await profileRequest(address, "/outings") as OutingStatus;
            if (activeOwner.current !== address) return;
            if (typeof value?.enabled !== "boolean" || !Array.isArray(value.jobs)) throw new Error("Invalid runner response");
            setStatusError(""); lastPoll.current = Date.now();
            hasActiveJobs.current = value.jobs.some(job => ["queued", "running"].includes(job.status));
            const spent = value.jobs.map(job => `${job.id}:${job.spent}`).join("|");
            if (spent !== lastSpent.current && payer) {
                lastSpent.current = spent;
                void import("../lib/grant").then(({readPayerBalance}) => readPayerBalance(payer)).then(amount => {if (activeOwner.current === address) setBalance(amount === undefined ? null : formatUnits(amount, 6));}).catch(() => {if (activeOwner.current === address) setBalance(null);});
            }
            setAvailable(value.enabled); serverAgent.current = value.agent;
            setJobs(value.jobs);
            const stored = readSubmission(address);
            if (stored && value.jobs.some(job => job.id === stored.id)) {clearSubmission(address); setSubmission(null);}
        } catch {if (activeOwner.current === address) {lastPoll.current = Date.now(); hasActiveJobs.current = false; setAvailable(false); setStatusError(locale === "ko" ? "외출 상태를 불러오지 못했어요. 연결을 확인하고 새로고침해 주세요." : "Could not check outings. Check your connection and refresh.");}}
        finally {refreshing.current = false;}
    }
    useEffect(() => {
        if (!address || !authenticated) return;
        const reload = () => {if (!document.hidden && !locked.current) void refreshOutings();};
        reload(); const poll = setInterval(() => {if (hasActiveJobs.current || Date.now() - lastPoll.current > 60_000) reload();}, 8000);
        window.addEventListener("focus", reload); window.addEventListener("online", reload); document.addEventListener("visibilitychange", reload);
        return () => {clearInterval(poll); window.removeEventListener("focus", reload); window.removeEventListener("online", reload); document.removeEventListener("visibilitychange", reload);};
    }, [address, authenticated, payer]);
    async function submitOuting(value: OutingSubmission) {
        if (!address) throw new GiwaTicketError("Wallet unavailable");
        // Persist before dispatch: a lost response must retry this id, never sign a new grant.
        saveSubmission(address, value); setSubmission(value);
        try {await profileRequest(address, "/outings", "POST", value);}
        catch (e) {
            // These rejections occur before insertion. Ambiguous/network failures keep the exact outbox.
            if (e instanceof ProfileError && ["invalid_request", "invalid_permission"].includes(e.code)) {clearSubmission(address); setSubmission(null);}
            throw e;
        }
        clearSubmission(address); setSubmission(null);
    }
    async function recoverSubmission() {
        if (!address || locked.current) return;
        let stored: OutingSubmission | null;
        try {stored = readSubmission(address);} catch {setError(locale === "ko" ? "외출 요청 기록을 읽지 못했어요. 저장 공간을 확인해 주세요." : "Cannot read the outing request. Check browser storage."); return;}
        if (!stored) return;
        locked.current = true; setBusy(true); setError("");
        try {await submitOuting(stored);}
        catch {setError(locale === "ko" ? "같은 외출 요청을 확인 중이에요. 새 서명이나 중복 출발은 하지 않아요." : "Checking the same outing. No new signature or duplicate departure.");}
        finally {locked.current = false; setBusy(false); await refreshOutings();}
    }
    async function controlJob(id: string, action: "stop" | "resume") {
        if (!address || locked.current) return;
        trackEngagement({event:'operator_action',locale});
        locked.current = true; setBusy(true); setError("");
        try {await profileRequest(address, `/outings/${encodeURIComponent(id)}/${action}`, "POST", {});}
        catch {setError(locale === "ko" ? "변경을 확인하지 못했어요. 현재 상태를 새로고침해 주세요." : "Could not confirm the change. Refresh outing status.");}
        finally {locked.current = false; setBusy(false); await refreshOutings();}
    }
    async function approve(requests: AllowanceRequest[], choice: GameId | "auto") {
        if (!address || !connector || locked.current) return;
        trackEngagement({event:'outing_started',locale});
        locked.current = true; setBusy(true); setError("");
        try {
            if (readSubmission(address)) throw new GiwaTicketError("먼저 외출 요청을 확인해 주세요. / Recover the existing outing request first.");
            if (!available || !serverAgent.current) throw new GiwaTicketError("자동 외출 서버가 준비되지 않았어요. 무료 연습을 이용해 주세요. / Outing server unavailable. Try free practice.");
            if (!requests.length || requests.length > 3 || new Set(requests.map(item => item.tokenId)).size !== requests.length ||
                requests.some(item => !validAllowance(item.admissions) || !guardianTokenId(item.tokenId) || !['explore','score','save'].includes(item.goal) || !item.name.trim())) throw new GiwaTicketError("친구별 용돈을 확인해 주세요. / Check each friend's allowance.");
            const active = jobs.filter(job => ["queued", "running", "paused"].includes(job.status));
            const targets = requests.filter(item => !active.some(job => activeGuardianOuting(job,item)));
            const agent = serverAgent.current;
            if (!targets.length) return;
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
            const [{derivePayerAccount, readPayerBalance, requestSponsoredBootstrap, verifyPermissionArtifact}, {prepareRootPermissionSigningRequest, assembleRootPermission}] = await Promise.all([
                import("../lib/grant"), import("@mapae/delegation/signing"),
            ]);
            const account = await derivePayerAccount(owner);
            for (const [index, target] of targets.entries()) {
                const {admissions, tokenId, goal, name} = target;
                setApprovalTarget({name, admissions, index: index + 1, total: targets.length});
                const policy = arcadePolicy(admissions);
                setPhase("preparing");
                const head = await publicClient.getBlock();
                const startDate = Number(head.timestamp) - 1;
                const signing = prepareRootPermissionSigningRequest({environment: deployment.environment,
                    accountOwnerSmartAccount: account, delegate: agent, policy, startDate});
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
                    name: `Mapae Arcade · ${name}`, source: "signed", artifact};
                const savedGrants = writeGrants({add: [grant]});
                setGrants(previous => savedGrants ? savedGrants.filter(isArcadeGrant) : [grant, ...previous]);
                if (!savedGrants) throw new GiwaTicketError("회수할 권한 기록을 저장하지 못했어요. 이 탭을 닫지 말고 저장 공간을 확인해 주세요. / Could not save the revocation record. Keep this tab open.");
                const sponsor = bootstrapAvailability();
                // All friends share the owner account; bootstrap only once per batch.
                if (index === 0 && sponsor.kind === "configured") {
                    setPhase("bootstrap");
                    await requestSponsoredBootstrap(sponsor.url, artifact, locale);
                }
                setPhase("verifying");
                const code = await publicClient.getCode({address: account});
                if (!code || code === "0x") throw new GiwaTicketError("Studio에서 스마트 계정을 준비해 주세요. / Set up your smart account in Studio.");
                await verifyPermissionArtifact(artifact, locale);
                const available = await readPayerBalance(account);
                setPayer(account); setBalance(available === undefined ? null : formatUnits(available, 6));
                const reserved = active.reduce((sum, item) => sum + item.reservedAdmissions, 0);
                const needed = targets.slice(index).reduce((sum, item) => sum + item.admissions, reserved);
                if (available === undefined || available < BigInt(needed) * ARCADE_TICKET_AMOUNT) throw new GiwaTicketError("테스트 토큰 잔액이 부족해요. faucet.mapae.io에서 @mapae_io를 팔로우하고 받아 주세요. / Not enough test tokens. Follow @mapae_io on faucet.mapae.io to get more.");
                if (activeOwner.current !== address || activeConnector.current !== connector.uid) throw new GiwaTicketError("지갑이 변경됐어요. / Wallet changed.");
                setPhase("submitting");
                await submitOuting({id: crypto.randomUUID(), tokenId, goal, choice, admissions,
                    permissionContext: artifact.permissionContext, locale});

            }
        } catch (e) {
            // Wallet/provider exceptions can embed signed request data. Only errors
            // created by this UI or the reviewed grant helpers are displayed elsewhere.
            const walletError = giwaWalletError(e);
            const ko = locale === "ko";
            const messages = {
                timeout: ko ? "지갑 응답을 받지 못해 이번 요청을 중단했어요. 지갑의 이전 요청을 거절한 뒤 다시 연결해 주세요. 늦게 온 서명으로 계정을 만들거나 결제하지 않아요." : "Wallet did not respond. Dismiss its previous request and reconnect. A late signature will not deploy an account or pay.",
                pending: ko ? "지갑에 이전 요청이 남아 있어요. 해당 지갑에서 요청을 거절한 뒤 다시 시도해 주세요." : "Your wallet has an earlier request pending. Dismiss it in that wallet before trying again.",
                chain: ko ? "연결한 지갑의 네트워크가 GIWA Sepolia가 아니에요. GIWA로 전환한 뒤 다시 시도해 주세요." : "Your selected wallet is not on GIWA Sepolia. Switch to GIWA and try again.",
                rejected: ko ? "이 친구의 서명을 취소했어요. 이미 출발한 친구는 계속 놀아요." : "This friend’s signature was cancelled. Friends already sent out keep playing.",
            };
            setError(walletError ? messages[walletError.code] : e instanceof GiwaTicketError ? e.message : ko ? "용돈 승인이 완료되지 않았어요. 연결한 지갑과 GIWA 네트워크를 확인해 주세요." : "Allowance not approved. Check your selected wallet and GIWA network.");
        } finally {locked.current = false; setBusy(false); setPhase("idle"); setApprovalTarget(null); await refreshOutings();}
    }
    function revoked(_context: Hex) {void refreshOutings();}
    function disconnect() {disconnectWallet();}
    return {payer, balance, jobs, available, submission, refreshOutings, recoverSubmission, controlJob,
        approvalTarget, busy, phase, chainId, walletName: connector?.name ?? "", error: error || statusError,
        grants, revoked, disconnect, approve};
}
