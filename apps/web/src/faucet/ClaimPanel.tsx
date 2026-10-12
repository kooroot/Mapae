import {FAUCET_MISSIONS, FAUCET_MUSDC_MISSIONS, type FaucetClaimView, type FaucetKind, type FaucetMissionId} from "@mapae/delegation/faucet-policy";
import {useQuery} from "@tanstack/react-query";
import {ArrowUpRight, Check, CircleAlert, Clock3, Droplets, LoaderCircle, PartyPopper, ShieldCheck} from "lucide-react";
import {useEffect, useState, type ReactNode} from "react";
import type {Address} from "viem";
import {MOCK_USDC} from "@mapae/shared";
import {appUrl, explorerAddressUrl, explorerTxUrl, landingUrl, publicClient} from "../lib/config";
import {localizeUrl} from "../lib/i18n";
import {shortAddress} from "../lib/dial";
import {useLocale} from "../lib/locale";
import {FaucetError, type FaucetPageStatus} from "./client";
import {ERROR_COPY, FAUCET_COPY, formatAmount, formatWait, MISSION_COPY} from "./copy";
import {useTurnstile} from "./Turnstile";

/**
 * One tab of the faucet: connect, finish the missions, claim — as a numbered stepper.
 *
 * The panel owns only the claim's progress and its error. What the wallet last received
 * (`view`) belongs to the page, which reads it from the session and keeps polling while
 * a claim is pending, so a reload shows the same standing as the moment after a claim.
 */

type Phase = "idle" | "signing" | "checking" | "sending";

export interface ClaimPanelProps {
    kind: FaucetKind;
    status: FaucetPageStatus | undefined;
    /** The status could not be read: the faucet is shown as resting. */
    statusFailed: boolean;
    owner: Address | undefined;
    wallet: ReactNode;
    /** The service's recipient for this kind, once a session names it. */
    recipient: Address | undefined;
    view: FaucetClaimView | null;
    /** True from this visit's own successful claim until the page is left. */
    fresh: boolean;
    pendingLong: boolean;
    missionsDone: readonly FaucetMissionId[];
    onMission: (id: FaucetMissionId) => void;
    /** Sign in when this browser has no session for `owner`; a no-op otherwise. */
    ensureSession: () => Promise<void>;
    submit: (input: {kind: FaucetKind; turnstile: string; missions: FaucetMissionId[]}) => Promise<void>;
}

/** A minute is the finest grain a cooldown shows, so the clock ticks once a minute. */
function useMinuteClock(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

export function ClaimPanel(props: ClaimPanelProps) {
    const {kind, status, owner, view} = props;
    const {locale} = useLocale(), t = FAUCET_COPY[locale];
    const now = useMinuteClock();
    const {slot, solve} = useTurnstile();
    const [phase, setPhase] = useState<Phase>("idle");
    const [error, setError] = useState<FaucetError | null>(null);
    useEffect(() => {setError(null);}, [owner]);

    const config = status?.[kind];
    const enabled = !!config?.enabled && !props.statusFailed;
    const missions: readonly FaucetMissionId[] = config?.missions ?? (kind === "musdc" ? FAUCET_MUSDC_MISSIONS : []);
    const missionsComplete = missions.every((id) => props.missionsDone.includes(id));
    const amount = kind === "musdc" ? formatAmount(status?.musdc.targetBase ?? "1000000000", "musdc") : formatAmount(status?.eth.amountWei ?? "50000000000000000", "eth");
    const nextAt = view?.nextAt ?? (error?.code === "cooldown" ? error.nextAt : undefined);
    const coolingDown = nextAt !== undefined && nextAt > now;
    const pending = view?.state === "pending";
    const busy = phase !== "idle";
    const ready = !!owner && enabled && missionsComplete && !coolingDown && !pending && !busy;

    async function claim() {
        if (!owner || !status) return;
        setError(null);
        try {
            setPhase("signing");
            await props.ensureSession();
            setPhase("checking");
            const turnstile = await solve({siteKey: status.siteKey, action: `claim-${kind}`, cData: owner.toLowerCase(), language: locale});
            setPhase("sending");
            await props.submit({kind, turnstile, missions: missions.filter((id) => props.missionsDone.includes(id))});
        } catch (e) {
            setError(e instanceof FaucetError ? e : new FaucetError("unavailable"));
        } finally {setPhase("idle");}
    }

    const off = status && !enabled || props.statusFailed;
    return (
        <div className="fct-panel">
            {off && (kind === "eth" ? (
                <div className="fct-notice fct-notice-soon"><Clock3 size={20} aria-hidden="true" /><div><strong>{t.ethSoon.title}</strong><p>{t.ethSoon.body(amount)}</p></div></div>
            ) : (
                <div className="fct-notice"><Clock3 size={20} aria-hidden="true" /><div><strong>{t.musdcOff.title}</strong><p>{t.musdcOff.body}</p></div></div>
            ))}
            <ol className="fct-steps">
                <Step n={1} title={t.steps.connect} done={!!owner} active={!owner}>{props.wallet}</Step>
                <Step n={2} title={t.steps.missions} done={!!owner && missionsComplete && missions.length > 0} active={!!owner && !missionsComplete}>
                    <ul className="fct-missions">
                        {missions.map((id) => {
                            const copy = MISSION_COPY[id][locale], done = props.missionsDone.includes(id);
                            return <li key={id} data-done={done}>
                                <div><strong>{copy.title}</strong><small>{copy.detail}</small></div>
                                {done ? <span className="fct-badge fct-badge-done"><Check size={14} aria-hidden="true" />{t.missionDone}</span> : (
                                    <a className="fct-action fct-action-secondary fct-action-small" href={FAUCET_MISSIONS[id].href} target="_blank" rel="noopener noreferrer" onClick={() => props.onMission(id)}>
                                        {copy.action}<ArrowUpRight size={16} aria-hidden="true" />
                                    </a>
                                )}
                            </li>;
                        })}
                        {missions.length === 0 && <li data-soon="true"><div><strong>{t.soonMission}</strong></div><span className="fct-badge">{t.soon}</span></li>}
                    </ul>
                </Step>
                <Step n={3} title={t.steps.claim} done={!!view && (view.state === "confirmed" || view.state === "already_enough") && (coolingDown || props.fresh)} active={!!owner && missionsComplete && enabled}>
                    {owner && <Recipient kind={kind} owner={owner} recipient={props.recipient} view={view} />}
                    <Outcome {...props} amount={amount} nextAt={coolingDown ? nextAt : undefined} />
                    <div className="fct-turnstile" ref={slot} />
                    <button type="button" className="fct-action fct-action-primary fct-claim" disabled={!ready} onClick={() => void claim()}>
                        {busy || pending ? <LoaderCircle size={18} className="mapae-spinner" aria-hidden="true" /> : <Droplets size={18} aria-hidden="true" />}
                        {phase === "signing" ? t.signing : phase === "checking" ? t.checking : phase === "sending" ? t.sending : pending ? t.pending : t.claim[kind](amount)}
                    </button>
                    <p className="fct-hint">
                        {!owner ? t.needConnect : !missionsComplete && enabled ? t.needMissions : phase === "signing" ? <><ShieldCheck size={14} aria-hidden="true" />{t.signingNote}</> : t.claimHint[kind](amount)}
                    </p>
                    {error && error.code !== "cooldown" && <p className="fct-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{ERROR_COPY[error.code][locale]}</p>}
                    {error?.code === "cooldown" && !coolingDown && <p className="fct-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{ERROR_COPY.cooldown[locale]}</p>}
                </Step>
            </ol>
        </div>
    );
}

function Step({n, title, done, active, children}: {n: number; title: string; done: boolean; active: boolean; children: ReactNode}) {
    return (
        <li className="fct-step" data-done={done} data-active={active}>
            <span className="fct-step-mark" aria-hidden="true">{done ? <Check size={15} strokeWidth={2.6} /> : n}</span>
            <div className="fct-step-body"><h3>{title}</h3>{children}</div>
        </li>
    );
}

/** Where this kind lands, and what it holds now — re-read whenever a claim settles. */
function Recipient({kind, owner, recipient, view}: {kind: FaucetKind; owner: Address; recipient: Address | undefined; view: FaucetClaimView | null}) {
    const {locale} = useLocale(), t = FAUCET_COPY[locale];
    const target = useQuery({
        queryKey: ["faucet-recipient", kind, owner, recipient ?? null, view?.state ?? null, view?.transaction ?? null],
        queryFn: async () => {
            if (kind === "eth") return {address: owner, balance: await publicClient.getBalance({address: owner})};
            // The payer derivation pulls the smart-account kit, so it loads only once a wallet is connected.
            const {derivePayerAccount, readPayerBalance} = await import("../lib/grant");
            const address = recipient ?? await derivePayerAccount(owner);
            return {address, balance: await readPayerBalance(address) ?? null};
        },
        staleTime: 15_000,
    });
    const address = target.data?.address ?? (kind === "eth" ? owner : recipient);
    const balance = target.data?.balance;
    return (
        <div className="fct-recipient">
            <span>{t.recipient[kind]}</span>
            <div>
                {address ? <a href={explorerAddressUrl(address)} target="_blank" rel="noopener noreferrer" title={t.explorer}><code>{shortAddress(address)}</code><ArrowUpRight size={14} aria-hidden="true" /></a> : <code className="fct-skeleton">0x····…····</code>}
                <span className="fct-balance">{t.balance} <strong>{balance === undefined || balance === null ? "—" : `${formatAmount(balance, kind)} ${kind === "musdc" ? MOCK_USDC.symbol : "ETH"}`}</strong></span>
            </div>
        </div>
    );
}

function Outcome(props: ClaimPanelProps & {amount: string; nextAt: number | undefined}) {
    const {kind, view, fresh, amount, nextAt} = props;
    const {locale} = useLocale(), t = FAUCET_COPY[locale];
    if (!view && nextAt === undefined) return null;
    if (view?.state === "pending") {
        return <div className="fct-outcome" role="status"><LoaderCircle size={20} className="mapae-spinner" aria-hidden="true" /><div><strong>{t.pending}</strong><p>{props.pendingLong ? t.pendingLong : t.pendingNote}</p>{view.transaction && <a href={explorerTxUrl(view.transaction)} target="_blank" rel="noopener noreferrer">{t.viewTx}<ArrowUpRight size={14} aria-hidden="true" /></a>}</div></div>;
    }
    if (view?.state === "confirmed" && fresh) {
        return <div className="fct-outcome fct-outcome-success" role="status">
            <PartyPopper size={22} aria-hidden="true" />
            <div>
                <strong>{t.success}</strong>
                <p>{t.successAmount[kind](formatAmount(view.amount, kind))}</p>
                {view.transaction && <a href={explorerTxUrl(view.transaction)} target="_blank" rel="noopener noreferrer">{t.viewTx}<ArrowUpRight size={14} aria-hidden="true" /></a>}
                {nextAt !== undefined && <p className="fct-wait"><Clock3 size={14} aria-hidden="true" />{t.cooldown(formatWait(nextAt - Date.now(), locale))}</p>}
                <div className="fct-next">
                    {kind === "musdc" && <a className="fct-action fct-action-primary" href={localizeUrl(`${landingUrl.replace(/\/$/, "")}/arcade`, locale)}>{t.toArcade}</a>}
                    <a className="fct-action fct-action-secondary" href={localizeUrl(appUrl, locale)}>{t.toStudio}</a>
                </div>
            </div>
        </div>;
    }
    if (nextAt !== undefined) {
        return <div className="fct-outcome" role="status"><Clock3 size={20} aria-hidden="true" /><div><strong>{t.cooldown(formatWait(nextAt - Date.now(), locale))}</strong>{view?.transaction && <a href={explorerTxUrl(view.transaction)} target="_blank" rel="noopener noreferrer">{t.lastTx}<ArrowUpRight size={14} aria-hidden="true" /></a>}</div></div>;
    }
    if (view?.state === "already_enough") {
        return <div className="fct-outcome" role="status"><Check size={20} aria-hidden="true" /><div><p>{t.alreadyEnough[kind](amount)}</p></div></div>;
    }
    if (view?.state === "failed") {
        return <div className="fct-outcome fct-outcome-failed" role="status"><CircleAlert size={20} aria-hidden="true" /><div><p>{t.failedBefore}</p></div></div>;
    }
    return null;
}
