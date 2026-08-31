import {createFileRoute} from "@tanstack/react-router";
import {Suspense, lazy, type ReactNode} from "react";
import {InterfaceIcon, type InterfaceIconName} from "../brand/marks";
import {Footer, Nav} from "../components/Shell";
import {Reveal} from "../components/Reveal";
import {Dial} from "../landing/Dial";
import {
    appUrl,
    docsUrl,
    explorerTxUrl,
    refusalsFor,
    settlements,
    siteSurface,
} from "../lib/config";
import {short} from "../lib/dial";
import {pick, type Locale} from "../lib/i18n";
import {resolveLocale, useLocale} from "../lib/locale";

const LazyStudio = lazy(() =>
    import("../dapp/Studio").then(({Studio}) => ({default: Studio})),
);

/*
 * Exported because `routes/ko/index.tsx` mounts the same surface at `/ko`. They must be
 * named bindings rather than `Route.options.component`: the router's code splitter
 * rejects a member expression there, and the failure is a build error rather than a
 * runtime one, so this is the only shape that works.
 */
export function rootSurfaceHead() {
    return siteSurface === "app"
        ? {
              meta: [
                  {title: "Mapae Studio — Delegated payment control"},
                  {
                      name: "description",
                      content: pick(resolveLocale(), {
                          en: "Approve asset, amount, period, and recipient boundaries from your wallet, and manage agent payment authority and settlement state on GIWA.",
                          ko: "자산·금액·기간·수취인 경계를 지갑으로 승인하고, GIWA에서 에이전트 결제 권한과 정산 상태를 관리합니다.",
                      }),
                  },
              ],
          }
        : {};
}

export const Route = createFileRoute("/")({
    component: RootSurface,
    head: rootSurfaceHead,
});

export function RootSurface() {
    return siteSurface === "app" ? (
        <Suspense fallback={<StudioEntryLoading />}>
            <LazyStudio />
        </Suspense>
    ) : (
        <Landing />
    );
}

function StudioEntryLoading() {
    const {locale} = useLocale();
    const t = COPY[locale];
    return (
        <div className="studio-entry-loading" aria-label={t.studioLoadingAria}>
            <i aria-hidden="true" />
            <span>MAPAE STUDIO</span>
        </div>
    );
}

const COPY: Record<
    Locale,
    {
        studioLoadingAria: string;
        hero: {
            titleLine1: string;
            titleLine2: string;
            sub: string;
            openStudio: string;
            howItWorks: string;
        };
        authority: {
            titleA: string;
            titleB: string;
            titleC: string;
            withoutTitle: string;
            without1: string;
            without2: string;
            without3: string;
            withTitle: string;
            with1: string;
            with2: string;
            with3: string;
        };
        mandate: {
            title: string;
            body: string;
        };
        flow: {
            titleLine1: string;
            titleLine2: string;
        };
        security: {
            titleLine1: string;
            titleLine2: string;
            body: string;
            docsLink: string;
        };
        evidence: {
            title: string;
            body: string;
            testnetNote: string;
        };
        finalCall: {
            titleLine1: string;
            titleLine2: string;
            body: string;
            openStudio: string;
            techDocs: string;
        };
    }
> = {
    en: {
        studioLoadingAria: "Loading Mapae Studio",
        hero: {
            titleLine1: "Don't hand over the authority.",
            titleLine2: "Delegate its boundaries.",
            sub: "Set the asset, amount, period, and recipient — the agent pays on its own within them. The owner can end it at any time.",
            openStudio: "Open Studio",
            howItWorks: "How it works",
        },
        authority: {
            titleA: "What an agent needs",
            titleB: "is not the whole wallet,",
            titleC: "but economic authority scoped to its purpose.",
            withoutTitle: "Hand over the key and trust",
            without1: "Access to the whole wallet",
            without2: "A backend promises the limit",
            without3: "Problems found after the fact",
            withTitle: "Set the boundaries and delegate",
            with1: "Delegate only the scope needed",
            with2: "The chain enforces every payment",
            with3: "Revoke the grant at any time",
        },
        mandate: {
            title: "The owner sets the boundaries. The chain enforces them.",
            body: "The numbers are not fixed in the product. Each grant is composed for its purpose, and the agent cannot step past the engraved scope.",
        },
        flow: {
            titleLine1: "Payments flow automatically,",
            titleLine2: "but the authority check is never skipped.",
        },
        security: {
            titleLine1: "Safety shows not in the payments that succeed,",
            titleLine2: "but in the payments that can be refused.",
            body: "What will execute is simulated as-is before settlement. A payment outside the granted scope is never broadcast — no funds move, no gas is wasted.",
            docsLink: "See the trust boundaries in the technical docs",
        },
        evidence: {
            title: "Before the explanation, a record you can verify.",
            body: "The links below are delegated payments actually settled on testnet. They are public evidence of technical behavior, not fixed product limits or operating metrics.",
            testnetNote:
                "The current public evidence was produced with GIWA Sepolia test assets. It does not indicate operational readiness for real-value assets.",
        },
        finalCall: {
            titleLine1: "Set the boundaries.",
            titleLine2: "The agent moves within them.",
            body: "Start autonomous payments without handing over your wallet.",
            openStudio: "Open Studio",
            techDocs: "Technical docs",
        },
    },
    ko: {
        studioLoadingAria: "Mapae Studio 불러오는 중",
        hero: {
            titleLine1: "권한을 넘기지 말고,",
            titleLine2: "경계를 위임하세요.",
            sub: "자산·금액·기간·수취인을 정하면 에이전트가 그 안에서 스스로 결제합니다. 소유자는 언제든 끝낼 수 있습니다.",
            openStudio: "Studio 열기",
            howItWorks: "작동 방식",
        },
        authority: {
            titleA: "에이전트에게 필요한 건",
            titleB: "지갑 전체가 아니라,",
            titleC: "목적에 맞는 경제적 권한입니다.",
            withoutTitle: "키를 건네고 믿는다",
            without1: "지갑 전체에 접근",
            without2: "백엔드가 한도를 약속",
            without3: "문제가 생긴 뒤 발견",
            withTitle: "경계를 정하고 맡긴다",
            with1: "필요한 범위만 위임",
            with2: "체인이 매 결제를 강제",
            with3: "언제든 권한을 회수",
        },
        mandate: {
            title: "소유자가 정하고, 체인이 지킵니다.",
            body: "숫자는 제품에 고정되어 있지 않습니다. 각 권한은 사용 목적에 맞게 구성되고, 에이전트는 새겨진 범위를 넘어설 수 없습니다.",
        },
        flow: {
            titleLine1: "결제는 자동으로 흐르지만,",
            titleLine2: "권한 검사는 생략되지 않습니다.",
        },
        security: {
            titleLine1: "안전성은 성공한 결제가 아니라,",
            titleLine2: "거절할 수 있는 결제에서 드러납니다.",
            body: "정산 전에 실행될 내용을 그대로 시뮬레이션합니다. 권한 범위를 벗어나면 브로드캐스트하지 않으므로 자금 이동과 불필요한 가스 지출이 없습니다.",
            docsLink: "기술 문서에서 신뢰 경계 보기",
        },
        evidence: {
            title: "설명보다 먼저, 확인할 수 있는 기록.",
            body: "아래 링크는 테스트넷에서 실제로 정산된 위임 결제입니다. 제품의 고정 한도나 운영 지표가 아니라 기술 동작을 검증하는 공개 증거입니다.",
            testnetNote:
                "현재 공개 증거는 GIWA Sepolia의 테스트 자산으로 생성되었습니다. 실제 가치 자산을 위한 운영 준비 상태를 의미하지 않습니다.",
        },
        finalCall: {
            titleLine1: "경계를 정하세요.",
            titleLine2: "에이전트가 그 안에서 움직입니다.",
            body: "지갑을 넘기지 않고도 자율 결제를 시작할 수 있습니다.",
            openStudio: "Studio 열기",
            techDocs: "기술 문서",
        },
    },
};

const STANDARDS = [
    {name: "GIWA", detail: "Settlement network"},
    {name: "x402", detail: "Payment handshake"},
    {name: "ERC-7710", detail: "Delegated authority"},
    {name: "ERC-4337", detail: "Smart account"},
] as const;

/*
 * Structural fields — index, icon, all-caps meta, and the English step titles — are
 * single-sourced, and only the prose carries a per-locale pair, so the two locales
 * cannot drift apart structurally.
 */
const BOUNDARY_SOURCE: Array<{
    index: string;
    icon: InterfaceIconName;
    meta: string;
    title: Record<Locale, string>;
    body: Record<Locale, string>;
}> = [
    {
        index: "01",
        icon: "asset-recipient",
        meta: "ASSET · RECIPIENT",
        title: {en: "Asset & recipient", ko: "자산과 상대"},
        body: {
            en: "First narrow which asset can be sent, and to whom.",
            ko: "어떤 자산을 누구에게 보낼 수 있는지 먼저 좁힙니다.",
        },
    },
    {
        index: "02",
        icon: "amount-cadence",
        meta: "AMOUNT · CADENCE",
        title: {en: "Amount & cadence", ko: "금액과 주기"},
        body: {
            en: "Set the cap for a single payment and for spending over a period.",
            ko: "한 번의 결제와 일정 기간 동안 쓸 수 있는 상한을 정합니다.",
        },
    },
    {
        index: "03",
        icon: "start-expiry",
        meta: "START · EXPIRY",
        title: {en: "Validity window", ko: "유효 기간"},
        body: {
            en: "The chain itself checks when the grant begins and ends.",
            ko: "권한이 시작되고 끝나는 시간을 체인이 직접 확인합니다.",
        },
    },
    {
        index: "04",
        icon: "owner-revoke",
        meta: "OWNER · REVOKE",
        title: {en: "Owner control", ko: "소유자 통제"},
        body: {
            en: "When needed, revoke the grant immediately instead of waiting for expiry.",
            ko: "필요하면 만료를 기다리지 않고 권한을 즉시 회수합니다.",
        },
    },
];

function localizedBoundaries(locale: Locale) {
    return BOUNDARY_SOURCE.map(({index, icon, meta, title, body}) => ({
        index,
        icon,
        meta,
        title: title[locale],
        body: body[locale],
    }));
}

const BOUNDARIES: Record<
    Locale,
    Array<{
        index: string;
        icon: InterfaceIconName;
        title: string;
        body: string;
        meta: string;
    }>
> = {
    en: localizedBoundaries("en"),
    ko: localizedBoundaries("ko"),
};

const FLOW_SOURCE: Array<{
    icon: InterfaceIconName;
    title: string;
    body: Record<Locale, string>;
}> = [
    {
        icon: "request",
        title: "Request",
        body: {
            en: "The agent requests a paid resource and receives the 402 payment terms.",
            ko: "에이전트가 유료 리소스를 요청하고 402 결제 조건을 받습니다.",
        },
    },
    {
        icon: "scope",
        title: "Scope",
        body: {
            en: "The agent builds a one-time permission carrying only this payment's amount and recipient.",
            ko: "해당 결제의 금액과 수취인만 담은 일회성 권한을 만듭니다.",
        },
    },
    {
        icon: "enforce",
        title: "Enforce",
        body: {
            en: "The chain checks that the asset, cap, period, and recipient are within the delegated scope.",
            ko: "체인이 자산·한도·기간·상대가 위임 범위 안인지 검사합니다.",
        },
    },
    {
        icon: "settle",
        title: "Settle",
        body: {
            en: "Only transactions that pass are settled on GIWA by the relayer.",
            ko: "통과한 거래만 릴레이어가 GIWA에 정산합니다.",
        },
    },
    {
        icon: "proceed",
        title: "Proceed",
        body: {
            en: "Once the settlement receipt is confirmed, the resource opens to the agent.",
            ko: "정산 영수증이 확인되면 리소스가 에이전트에게 열립니다.",
        },
    },
];

const FLOW: Record<Locale, Array<{icon: InterfaceIconName; title: string; body: ReactNode}>> = {
    en: FLOW_SOURCE.map(({icon, title, body}) => ({icon, title, body: body.en})),
    ko: FLOW_SOURCE.map(({icon, title, body}) => ({icon, title, body: body.ko})),
};

export function Landing() {
    return (
        <>
            <Nav variant="dark" />
            <main className="home">
                <Hero />
                <StandardRail />
                <Authority />
                <Mandate />
                <PaymentFlow />
                <Security />
                <Evidence />
                <FinalCall />
            </main>
            <Footer variant="dark" />
        </>
    );
}

function Hero() {
    const {locale} = useLocale();
    const t = COPY[locale].hero;
    return (
        <section className="home-hero hero-action" aria-labelledby="hero-title">
            <div className="hero-action-sticky">
                <div className="home-hero-copy">
                    <span className="home-kicker">SCOPED PAYMENT AUTHORITY</span>
                    <h1 id="hero-title">
                        {t.titleLine1}
                        <strong>{t.titleLine2}</strong>
                    </h1>
                    <p>{t.sub}</p>
                    <div className="home-actions">
                        <a href={appUrl} className="home-button home-button-primary">
                            {t.openStudio}
                            <span aria-hidden="true">↗</span>
                        </a>
                        <a className="home-button home-button-secondary" href="#authority">
                            {t.howItWorks}
                            <span aria-hidden="true">↓</span>
                        </a>
                    </div>
                </div>
                <div className="home-hero-meta" aria-hidden="true">
                    <span>MAPAE · GIWA</span>
                    <span>LIMIT THE AUTHORITY · LET THE AGENT ACT</span>
                </div>
                <Dial />
            </div>
        </section>
    );
}

function StandardRail() {
    return (
        <section className="home-standard-rail" aria-label="Mapae protocol foundation">
            <div className="home-wrap home-standard-grid">
                <p>BUILT ON OPEN RAILS</p>
                {STANDARDS.map((standard) => (
                    <div key={standard.name}>
                        <strong>{standard.name}</strong>
                        <span>{standard.detail}</span>
                    </div>
                ))}
            </div>
        </section>
    );
}

function Authority() {
    const {locale} = useLocale();
    const t = COPY[locale].authority;
    return (
        <section className="home-section home-authority" id="authority">
            <div className="home-wrap">
                <Reveal className="home-section-head">
                    <span className="home-kicker">THE CONTROL LAYER</span>
                    <h2 className="home-authority-title">
                        <span>{t.titleA}</span>
                        <span>{t.titleB}</span>
                        <strong>{t.titleC}</strong>
                    </h2>
                </Reveal>
                <div className="home-contrast">
                    <Reveal className="home-contrast-panel home-contrast-before">
                        <span className="home-panel-index">WITHOUT MAPAE</span>
                        <h3>{t.withoutTitle}</h3>
                        <ul>
                            <li>{t.without1}</li>
                            <li>{t.without2}</li>
                            <li>{t.without3}</li>
                        </ul>
                    </Reveal>
                    <Reveal className="home-contrast-divider" delay={80}>
                        <span aria-hidden="true">→</span>
                    </Reveal>
                    <Reveal className="home-contrast-panel home-contrast-after" delay={120}>
                        <span className="home-panel-index">WITH MAPAE</span>
                        <h3>{t.withTitle}</h3>
                        <ul>
                            <li>{t.with1}</li>
                            <li>{t.with2}</li>
                            <li>{t.with3}</li>
                        </ul>
                    </Reveal>
                </div>
            </div>
        </section>
    );
}

function Mandate() {
    const {locale} = useLocale();
    const t = COPY[locale].mandate;
    return (
        <section className="home-section home-mandate" id="boundaries">
            <div className="home-wrap">
                <Reveal className="home-section-head home-section-head-split">
                    <div>
                        <span className="home-kicker">ONE MANDATE · FOUR BOUNDARIES</span>
                        <h2>{t.title}</h2>
                    </div>
                    <p>{t.body}</p>
                </Reveal>

                <div className="home-boundary-grid">
                    <div className="home-boundary-core" aria-hidden="true">
                        <span className="home-core-orbit home-core-orbit-a" />
                        <span className="home-core-orbit home-core-orbit-b" />
                        <span className="home-core-seal">
                            <img
                                src="/brand/emblem.png"
                                alt=""
                                width={439}
                                height={512}
                            />
                        </span>
                        <small>OWNER-SIGNED AUTHORITY</small>
                    </div>
                    <ol className="home-boundary-list">
                        {BOUNDARIES[locale].map((boundary, index) => (
                            <Reveal as="li" key={boundary.title} delay={index * 70}>
                                <article className="home-boundary-card">
                                    <span className="home-boundary-index">{boundary.index}</span>
                                    <span className="home-boundary-symbol" aria-hidden="true">
                                        <InterfaceIcon
                                            name={boundary.icon}
                                            size={28}
                                            className="home-boundary-icon"
                                        />
                                    </span>
                                    <div>
                                        <span className="home-boundary-meta">{boundary.meta}</span>
                                        <h3>{boundary.title}</h3>
                                        <p>{boundary.body}</p>
                                    </div>
                                </article>
                            </Reveal>
                        ))}
                    </ol>
                </div>
            </div>
        </section>
    );
}

function PaymentFlow() {
    const {locale} = useLocale();
    const t = COPY[locale].flow;
    return (
        <section className="home-section home-flow" id="flow">
            <div className="home-wrap">
                <Reveal className="home-section-head">
                    <span className="home-kicker">REQUEST · PAY · PROCEED</span>
                    <h2>
                        {t.titleLine1}
                        <strong>{t.titleLine2}</strong>
                    </h2>
                </Reveal>
                <ol className="home-flow-list">
                    {FLOW[locale].map((step, index) => (
                        <Reveal as="li" key={step.title} delay={index * 70}>
                            <article className="home-flow-step">
                                <div className="home-flow-marker">
                                    <span>{String(index + 1).padStart(2, "0")}</span>
                                    <i className="home-flow-symbol" aria-hidden="true">
                                        <InterfaceIcon
                                            name={step.icon}
                                            size={26}
                                            className="home-flow-icon"
                                        />
                                    </i>
                                </div>
                                <h3>{step.title}</h3>
                                <p>{step.body}</p>
                            </article>
                        </Reveal>
                    ))}
                </ol>
            </div>
        </section>
    );
}

function Security() {
    const {locale} = useLocale();
    const t = COPY[locale].security;
    return (
        <section className="home-section home-security" id="security">
            <div className="home-wrap home-security-grid">
                <Reveal className="home-security-copy">
                    <span className="home-kicker">SECURITY BY REFUSAL</span>
                    <h2>
                        {t.titleLine1}
                        <strong>{t.titleLine2}</strong>
                    </h2>
                    <p>{t.body}</p>
                    <a href={docsUrl} target="_blank" rel="noreferrer noopener">
                        {t.docsLink} <span aria-hidden="true">↗</span>
                    </a>
                </Reveal>
                <div className="home-refusal-list">
                    {refusalsFor(locale).map((refusal, index) => (
                        <Reveal key={refusal.revert} delay={index * 90}>
                            <article className="home-refusal">
                                <span>{String(index + 1).padStart(2, "0")}</span>
                                <div>
                                    <h3>{refusal.attempt}</h3>
                                    <code>{refusal.revert}</code>
                                </div>
                                <strong>REFUSED</strong>
                            </article>
                        </Reveal>
                    ))}
                </div>
            </div>
        </section>
    );
}

function Evidence() {
    const {locale} = useLocale();
    const t = COPY[locale].evidence;
    return (
        <section className="home-section home-evidence" id="evidence">
            <div className="home-wrap">
                <Reveal className="home-section-head home-section-head-split">
                    <div>
                        <span className="home-kicker">GIWA SEPOLIA EVIDENCE</span>
                        <h2>{t.title}</h2>
                    </div>
                    <p>{t.body}</p>
                </Reveal>

                <div className="home-evidence-table">
                    <div className="home-evidence-head" aria-hidden="true">
                        <span>RECEIPT</span>
                        <span>NETWORK</span>
                        <span>TRANSACTION</span>
                    </div>
                    {settlements.map((settlement, index) => (
                        <Reveal key={settlement.hash} delay={index * 70}>
                            <a
                                className="home-evidence-row"
                                href={explorerTxUrl(settlement.hash)}
                                target="_blank"
                                rel="noreferrer noopener"
                            >
                                <span>SETTLEMENT {String(index + 1).padStart(2, "0")}</span>
                                <span>GIWA SEPOLIA</span>
                                <strong>
                                    {short(settlement.hash)}
                                    <i aria-hidden="true">↗</i>
                                </strong>
                            </a>
                        </Reveal>
                    ))}
                </div>
                <Reveal className="home-testnet-note">
                    <span>TESTNET ONLY</span>
                    <p>{t.testnetNote}</p>
                </Reveal>
            </div>
        </section>
    );
}

function FinalCall() {
    const {locale} = useLocale();
    const t = COPY[locale].finalCall;
    return (
        <section className="home-final">
            <div className="home-final-glow" aria-hidden="true" />
            <div className="home-wrap">
                <Reveal>
                    <span className="home-kicker">PASS · PAY · PROCEED</span>
                    <h2>
                        {t.titleLine1}
                        <strong>{t.titleLine2}</strong>
                    </h2>
                    <p>{t.body}</p>
                    <div className="home-actions home-final-actions">
                        <a href={appUrl} className="home-button home-button-primary">
                            {t.openStudio} <span aria-hidden="true">↗</span>
                        </a>
                        <a
                            className="home-button home-button-secondary"
                            href={docsUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            {t.techDocs} <span aria-hidden="true">↗</span>
                        </a>
                    </div>
                </Reveal>
            </div>
        </section>
    );
}
