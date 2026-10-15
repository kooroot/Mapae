import {Tabs} from "@base-ui/react/tabs";
import {FAUCET_ETH_AMOUNT_WEI, FAUCET_KINDS, FAUCET_MISSIONS, type FaucetClaimView, type FaucetKind, type FaucetMissionId} from "@mapae/delegation/faucet-policy";
import {MOCK_USDC} from "@mapae/shared";
import {useQuery} from "@tanstack/react-query";
import {ArrowUpRight, AtSign, ChevronDown, Coins, Flame, Gamepad2, Plus, Terminal} from "lucide-react";
import {useCallback, useEffect, useRef, useState} from "react";
import type {Address} from "viem";
import {useAccount, useDisconnect, useSignMessage, useSwitchChain, useWatchAsset} from "wagmi";
import {Lockup, PassEmblem} from "../brand/marks";
import {WalletPicker} from "../components/WalletPicker";
import {Web3Providers} from "../dapp/Web3Providers";
import {appUrl, chain, docsUrl, faucetUrl, landingUrl} from "../lib/config";
import {shortAddress} from "../lib/dial";
import {localizeUrl} from "../lib/i18n";
import {LocaleSwitch, useLocale} from "../lib/locale";
import {ClaimPanel} from "./ClaimPanel";
import {claimFaucet, FaucetError, loginFaucet, readFaucetAccount, readFaucetStatus} from "./client";
import {FAUCET_COPY, formatAmount} from "./copy";
import "./faucet.css";

/**
 * faucet.mapae.io: testnet tokens behind a wallet sign-in, a follow and a bot check.
 *
 * The page holds the wallet's standing — where each kind lands and the latest claim of
 * each — and refreshes it from the session; each tab's panel holds only its own claim in
 * progress. Nothing here decides an amount or a window: the service does, and the page
 * shows what it was told.
 */
export function FaucetPage() {
    return <Web3Providers><FaucetScreen /></Web3Providers>;
}

type Views = Record<FaucetKind, FaucetClaimView | null>;
const NO_VIEWS: Views = {musdc: null, eth: null};
/** A pending claim is re-read this often, and for this long before the page says it is slow. */
const POLL_MS = 4_000, POLL_LIMIT_MS = 120_000;

function FaucetScreen() {
    const {locale} = useLocale(), t = FAUCET_COPY[locale];
    const {address, chainId, status: walletStatus} = useAccount();
    const {disconnect} = useDisconnect();
    const {switchChain, isPending: switching} = useSwitchChain();
    const {signMessageAsync} = useSignMessage();
    const status = useQuery({queryKey: ["faucet-status"], queryFn: readFaucetStatus, staleTime: 30_000, retry: 1});

    const [tab, setTab] = useState<FaucetKind>("musdc");
    // The arcade links straight to the ETH tab with `#eth`, read after hydration so the served markup still matches; it opens even while that tab says it is coming soon.
    useEffect(() => {if (location.hash === "#eth") setTab("eth");}, []);
    const [views, setViews] = useState<Views>(NO_VIEWS);
    const [recipient, setRecipient] = useState<Address>();
    const [signedIn, setSignedIn] = useState(false);
    const [fresh, setFresh] = useState<Record<FaucetKind, boolean>>({musdc: false, eth: false});
    const [pendingLong, setPendingLong] = useState(false);
    // The follow is the person's act, not the wallet's: one click covers this visit whichever wallet connects, and a reload asks again.
    const [missions, setMissions] = useState<FaucetMissionId[]>([]);
    const current = useRef<Address | undefined>(undefined);

    const refresh = useCallback(async (owner: Address) => {
        try {
            const account = await readFaucetAccount(owner);
            if (current.current !== owner) return;
            setViews({musdc: account.musdc, eth: account.eth});
            setRecipient(account.recipients.musdc);
            setSignedIn(true);
        } catch (e) {
            if (current.current === owner && e instanceof FaucetError && e.code === "login_required") setSignedIn(false);
        }
    }, []);

    useEffect(() => {
        current.current = address;
        setViews(NO_VIEWS); setRecipient(undefined); setSignedIn(false); setFresh({musdc: false, eth: false}); setPendingLong(false);
        if (address) void refresh(address);
    }, [address, refresh]);

    const anyPending = views.musdc?.state === "pending" || views.eth?.state === "pending";
    useEffect(() => {
        if (!address || !anyPending) {setPendingLong(false); return;}
        const started = Date.now();
        const timer = setInterval(() => {
            if (Date.now() - started > POLL_LIMIT_MS) {setPendingLong(true); clearInterval(timer); return;}
            void refresh(address);
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [address, anyPending, refresh]);

    const onMission = (id: FaucetMissionId) => setMissions((done) => [...new Set([...done, id])]);

    const ensureSession = async () => {
        if (!address) throw new FaucetError("login_required");
        if (signedIn) return;
        await loginFaucet(address, (message) => signMessageAsync({message}));
        setSignedIn(true);
        await refresh(address);
    };

    const submit = async (input: {kind: FaucetKind; turnstile: string; missions: FaucetMissionId[]}) => {
        if (!address) throw new FaucetError("login_required");
        try {
            const view = await claimFaucet(address, input);
            if (current.current !== address) return;
            setViews((previous) => ({...previous, [input.kind]: view}));
            setFresh((previous) => ({...previous, [input.kind]: true}));
            if (input.kind === "musdc") setRecipient(view.recipient);
        } catch (e) {
            if (e instanceof FaucetError && e.code === "login_required") setSignedIn(false);
            throw e;
        }
    };

    const wallet = address ? (
        <div className="fct-wallet">
            <div className="fct-wallet-row">
                <span className="fct-chip"><i aria-hidden="true" />{t.connected} · <code>{shortAddress(address)}</code></span>
                <button type="button" className="fct-text-button" onClick={() => disconnect()}>{t.disconnect}</button>
            </div>
            {chainId !== chain.id && <div className="fct-chain"><span>{t.wrongChain}</span><button type="button" className="fct-action fct-action-secondary fct-action-small" disabled={switching} onClick={() => switchChain({chainId: chain.id})}>{t.switchChain}</button></div>}
        </div>
    ) : <WalletPicker context="faucet" reconnecting={walletStatus === "reconnecting" || walletStatus === "connecting"} />;

    const ethAmount = formatAmount(status.data?.eth.amountWei ?? String(FAUCET_ETH_AMOUNT_WEI), "eth");
    const followed = missions.includes("x_follow_mapae");
    const arcadeHref = localizeUrl(`${landingUrl.replace(/\/$/, "")}/arcade`, locale);
    return (
        <div className="fct-page">
            <header className="fct-header">
                <a className="fct-home" href={localizeUrl(faucetUrl, locale)} aria-label="Mapae Faucet"><Lockup /><span className="fct-tag">Faucet</span></a>
                <nav className="fct-nav">
                    <a href={arcadeHref}>{t.nav.arcade}</a>
                    <a href={localizeUrl(appUrl, locale)}>{t.nav.studio}</a>
                    <LocaleSwitch />
                </nav>
            </header>
            <main className="fct-main">
                <section className="fct-workspace" aria-labelledby="fct-title">
                    <div className="fct-intro">
                        <div className="fct-hero">
                            <p className="fct-eyebrow"><span />GIWA SEPOLIA TESTNET</p>
                            <h1 id="fct-title">{t.title}<br /><span>{t.titleEnd}</span></h1>
                            <p className="fct-lead">{t.intro}</p>
                            <a className="fct-follow" data-done={followed} href={FAUCET_MISSIONS.x_follow_mapae.href} target="_blank" rel="noopener noreferrer" onClick={() => onMission("x_follow_mapae")}>
                                <AtSign size={18} aria-hidden="true" />{followed ? t.followDone : t.followHero}<ArrowUpRight size={17} aria-hidden="true" />
                            </a>
                            <p className="fct-follow-note">{t.followNote}</p>
                        </div>
                        <div className="fct-emblem-scene" aria-hidden="true">
                            <div className="fct-orbit fct-orbit-outer" /><div className="fct-orbit fct-orbit-inner" />
                            <span className="fct-orbit-point" />
                            <div className="fct-seal"><PassEmblem size={104} /></div>
                            <span className="fct-scene-label">PASS. PAY. PROCEED.</span>
                        </div>
                        <div className="fct-explore">
                            <a href={arcadeHref}><Gamepad2 size={20} aria-hidden="true" /><span><strong>{t.nav.arcade}</strong><small>{t.explore.arcade}</small></span><ArrowUpRight size={17} aria-hidden="true" /></a>
                            <a href={localizeUrl(appUrl, locale)}><Terminal size={20} aria-hidden="true" /><span><strong>{t.nav.studio}</strong><small>{t.explore.studio}</small></span><ArrowUpRight size={17} aria-hidden="true" /></a>
                        </div>
                    </div>
                    <div className="fct-dispenser">
                        <Tabs.Root className="fct-tabs" value={tab} onValueChange={(value) => setTab(value as FaucetKind)}>
                            <Tabs.List className="fct-tablist" aria-label={t.tabsLabel}>
                                {FAUCET_KINDS.map((kind) => (
                                    <Tabs.Tab key={kind} value={kind} className="fct-tab">
                                        {kind === "musdc" ? <Coins size={17} aria-hidden="true" /> : <Flame size={17} aria-hidden="true" />}
                                        <span><strong>{t.tabs[kind]}</strong><small>{kind === "eth" && status.data && !status.data.eth.enabled ? t.soon : t.tokenUse[kind]}</small></span>
                                    </Tabs.Tab>
                                ))}
                            </Tabs.List>
                            {FAUCET_KINDS.map((kind) => (
                                <Tabs.Panel key={kind} value={kind} className="fct-card">
                                    <ClaimPanel
                                        kind={kind} status={status.data} statusFailed={status.isError} owner={address} wallet={wallet}
                                        recipient={kind === "eth" ? address : recipient} view={views[kind]} fresh={fresh[kind]} pendingLong={pendingLong}
                                        missionsDone={missions} onMission={onMission} ensureSession={ensureSession} submit={submit}
                                    />
                                    {kind === "eth" && <div className="fct-rules"><h3>{t.ethRules.title}</h3><ul>{t.ethRules.items(ethAmount).map((item) => <li key={item}>{item}</li>)}</ul></div>}
                                </Tabs.Panel>
                            ))}
                        </Tabs.Root>
                        <p className="fct-testnet-note">{t.subline}</p>
                    </div>
                </section>
                <section className="fct-faq" aria-labelledby="fct-faq-title">
                    <div className="fct-faq-heading"><p className="fct-eyebrow">GOOD TO KNOW</p><h2 id="fct-faq-title">{t.howTo.title}</h2><p>{t.faqIntro}</p><a href={docsUrl} target="_blank" rel="noopener noreferrer">Mapae Docs<ArrowUpRight size={15} aria-hidden="true" /></a></div>
                    <div className="fct-faq-list">
                        {t.howTo.items.map((item) => (
                            <details key={item.id} className="fct-faq-item">
                                <summary>{item.q}<ChevronDown size={18} aria-hidden="true" /></summary>
                                <p>{item.a}</p>
                                {item.id === "wallet" && address && <WatchToken />}
                            </details>
                        ))}
                    </div>
                </section>
            </main>
            <footer className="fct-foot">
                <span>{t.footer}</span>
                <a href={arcadeHref}>{t.nav.arcade}</a>
                <a href={localizeUrl(appUrl, locale)}>{t.nav.studio}</a>
                <a href={docsUrl} target="_blank" rel="noopener noreferrer">Docs</a>
                <a href="https://x.com/mapae_io" target="_blank" rel="noopener noreferrer">X @mapae_io</a>
            </footer>
        </div>
    );
}

/** `wallet_watchAsset` for the test stablecoin — the wallet shows the address's own balance, said plainly. */
function WatchToken() {
    const {locale} = useLocale(), t = FAUCET_COPY[locale];
    const {watchAssetAsync, isPending, isSuccess} = useWatchAsset();
    return (
        <div className="fct-watch">
            <button type="button" className="fct-action fct-action-secondary fct-action-small" disabled={isPending}
                onClick={() => void watchAssetAsync({type: "ERC20", options: {address: MOCK_USDC.address, symbol: MOCK_USDC.symbol, decimals: MOCK_USDC.decimals}}).catch(() => {/* Declined in the wallet: nothing to say. */})}>
                <Plus size={15} aria-hidden="true" />{t.watchAsset}
            </button>
            <small>{isSuccess ? t.watchAssetDone : t.watchAssetNote}</small>
        </div>
    );
}
