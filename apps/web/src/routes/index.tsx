import {Link, createFileRoute} from "@tanstack/react-router";
import {Suspense, lazy, type ReactNode} from "react";
import {InterfaceIcon, type InterfaceIconName} from "../brand/marks";
import {Footer, Nav} from "../components/Shell";
import {Reveal} from "../components/Reveal";
import {Dial} from "../landing/Dial";
import {
    appUrl,
    docsUrl,
    explorerTxUrl,
    refusals,
    settlements,
    siteSurface,
} from "../lib/config";
import {short} from "../lib/dial";

const LazyStudio = lazy(() =>
    import("../dapp/Studio").then(({Studio}) => ({default: Studio})),
);

export const Route = createFileRoute("/")({
    component: RootSurface,
    head: () =>
        siteSurface === "app"
            ? {
                  meta: [
                      {title: "Mapae Studio — Delegated payment control"},
                      {
                          name: "description",
                          content:
                              "자산·금액·기간·수취인 경계를 지갑으로 승인하고, GIWA에서 에이전트 결제 권한과 정산 상태를 관리합니다.",
                      },
                  ],
              }
            : {},
});

function RootSurface() {
    return siteSurface === "app" ? (
        <Suspense fallback={<StudioEntryLoading />}>
            <LazyStudio />
        </Suspense>
    ) : (
        <Landing />
    );
}

function StudioEntryLoading() {
    return (
        <div className="studio-entry-loading" aria-label="Mapae Studio 불러오는 중">
            <i aria-hidden="true" />
            <span>MAPAE STUDIO</span>
        </div>
    );
}

const STANDARDS = [
    {name: "GIWA", detail: "Settlement network"},
    {name: "x402", detail: "Payment handshake"},
    {name: "ERC-7710", detail: "Delegated authority"},
    {name: "ERC-4337", detail: "Smart account"},
] as const;

const BOUNDARIES: Array<{
    index: string;
    icon: InterfaceIconName;
    title: string;
    body: string;
    meta: string;
}> = [
    {
        index: "01",
        icon: "asset-recipient",
        title: "자산과 상대",
        body: "어떤 자산을 누구에게 보낼 수 있는지 먼저 좁힙니다.",
        meta: "ASSET · RECIPIENT",
    },
    {
        index: "02",
        icon: "amount-cadence",
        title: "금액과 주기",
        body: "한 번의 결제와 일정 기간 동안 쓸 수 있는 상한을 정합니다.",
        meta: "AMOUNT · CADENCE",
    },
    {
        index: "03",
        icon: "start-expiry",
        title: "유효 기간",
        body: "권한이 시작되고 끝나는 시간을 체인이 직접 확인합니다.",
        meta: "START · EXPIRY",
    },
    {
        index: "04",
        icon: "owner-revoke",
        title: "소유자 통제",
        body: "필요하면 만료를 기다리지 않고 권한을 즉시 회수합니다.",
        meta: "OWNER · REVOKE",
    },
];

const FLOW: Array<{icon: InterfaceIconName; title: string; body: ReactNode}> = [
    {
        icon: "request",
        title: "Request",
        body: "에이전트가 유료 리소스를 요청하고 402 결제 조건을 받습니다.",
    },
    {
        icon: "scope",
        title: "Scope",
        body: "해당 결제의 금액과 수취인만 담은 일회성 권한을 만듭니다.",
    },
    {
        icon: "enforce",
        title: "Enforce",
        body: "체인이 자산·한도·기간·상대가 위임 범위 안인지 검사합니다.",
    },
    {
        icon: "settle",
        title: "Settle",
        body: "통과한 거래만 릴레이어가 GIWA에 정산합니다.",
    },
    {
        icon: "proceed",
        title: "Proceed",
        body: "정산 영수증이 확인되면 리소스가 에이전트에게 열립니다.",
    },
];

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
    return (
        <section className="home-hero hero-action" aria-labelledby="hero-title">
            <div className="hero-action-sticky">
                <div className="home-hero-copy">
                    <span className="home-kicker">SCOPED PAYMENT AUTHORITY</span>
                    <h1 id="hero-title">
                        권한을 넘기지 말고,
                        <strong>경계를 위임하세요.</strong>
                    </h1>
                    <p>
                        자산·금액·기간·수취인을 정하면 에이전트가 그 안에서 스스로
                        결제합니다. 소유자는 언제든 끝낼 수 있습니다.
                    </p>
                    <div className="home-actions">
                        <a href={appUrl} className="home-button home-button-primary">
                            Studio 열기
                            <span aria-hidden="true">↗</span>
                        </a>
                        <a className="home-button home-button-secondary" href="#authority">
                            작동 방식
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
    return (
        <section className="home-section home-authority" id="authority">
            <div className="home-wrap">
                <Reveal className="home-section-head">
                    <span className="home-kicker">THE CONTROL LAYER</span>
                    <h2 className="home-authority-title">
                        <span>에이전트에게 필요한 건</span>
                        <span>지갑 전체가 아니라,</span>
                        <strong>목적에 맞는 경제적 권한입니다.</strong>
                    </h2>
                </Reveal>
                <div className="home-contrast">
                    <Reveal className="home-contrast-panel home-contrast-before">
                        <span className="home-panel-index">WITHOUT MAPAE</span>
                        <h3>키를 건네고 믿는다</h3>
                        <ul>
                            <li>지갑 전체에 접근</li>
                            <li>백엔드가 한도를 약속</li>
                            <li>문제가 생긴 뒤 발견</li>
                        </ul>
                    </Reveal>
                    <Reveal className="home-contrast-divider" delay={80}>
                        <span aria-hidden="true">→</span>
                    </Reveal>
                    <Reveal className="home-contrast-panel home-contrast-after" delay={120}>
                        <span className="home-panel-index">WITH MAPAE</span>
                        <h3>경계를 정하고 맡긴다</h3>
                        <ul>
                            <li>필요한 범위만 위임</li>
                            <li>체인이 매 결제를 강제</li>
                            <li>언제든 권한을 회수</li>
                        </ul>
                    </Reveal>
                </div>
            </div>
        </section>
    );
}

function Mandate() {
    return (
        <section className="home-section home-mandate" id="boundaries">
            <div className="home-wrap">
                <Reveal className="home-section-head home-section-head-split">
                    <div>
                        <span className="home-kicker">ONE MANDATE · FOUR BOUNDARIES</span>
                        <h2>소유자가 정하고, 체인이 지킵니다.</h2>
                    </div>
                    <p>
                        숫자는 제품에 고정되어 있지 않습니다. 각 권한은 사용 목적에 맞게
                        구성되고, 에이전트는 새겨진 범위를 넘어설 수 없습니다.
                    </p>
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
                        {BOUNDARIES.map((boundary, index) => (
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
    return (
        <section className="home-section home-flow" id="flow">
            <div className="home-wrap">
                <Reveal className="home-section-head">
                    <span className="home-kicker">REQUEST · PAY · PROCEED</span>
                    <h2>
                        결제는 자동으로 흐르지만,
                        <strong>권한 검사는 생략되지 않습니다.</strong>
                    </h2>
                </Reveal>
                <ol className="home-flow-list">
                    {FLOW.map((step, index) => (
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
    return (
        <section className="home-section home-security" id="security">
            <div className="home-wrap home-security-grid">
                <Reveal className="home-security-copy">
                    <span className="home-kicker">SECURITY BY REFUSAL</span>
                    <h2>
                        안전성은 성공한 결제가 아니라,
                        <strong>거절할 수 있는 결제에서 드러납니다.</strong>
                    </h2>
                    <p>
                        정산 전에 실행될 내용을 그대로 시뮬레이션합니다. 권한 범위를 벗어나면
                        브로드캐스트하지 않으므로 자금 이동과 불필요한 가스 지출이 없습니다.
                    </p>
                    <a href={docsUrl} target="_blank" rel="noreferrer noopener">
                        기술 문서에서 신뢰 경계 보기 <span aria-hidden="true">↗</span>
                    </a>
                </Reveal>
                <div className="home-refusal-list">
                    {refusals.map((refusal, index) => (
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
    return (
        <section className="home-section home-evidence" id="evidence">
            <div className="home-wrap">
                <Reveal className="home-section-head home-section-head-split">
                    <div>
                        <span className="home-kicker">GIWA SEPOLIA EVIDENCE</span>
                        <h2>설명보다 먼저, 확인할 수 있는 기록.</h2>
                    </div>
                    <p>
                        아래 링크는 테스트넷에서 실제로 정산된 위임 결제입니다. 제품의 고정
                        한도나 운영 지표가 아니라 기술 동작을 검증하는 공개 증거입니다.
                    </p>
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
                    <p>
                        현재 공개 증거는 GIWA Sepolia의 테스트 자산으로 생성되었습니다. 실제
                        가치 자산을 위한 운영 준비 상태를 의미하지 않습니다.
                    </p>
                </Reveal>
            </div>
        </section>
    );
}

function FinalCall() {
    return (
        <section className="home-final">
            <div className="home-final-glow" aria-hidden="true" />
            <div className="home-wrap">
                <Reveal>
                    <span className="home-kicker">PASS · PAY · PROCEED</span>
                    <h2>
                        경계를 정하세요.
                        <strong>에이전트가 그 안에서 움직입니다.</strong>
                    </h2>
                    <p>지갑을 넘기지 않고도 자율 결제를 시작할 수 있습니다.</p>
                    <div className="home-actions home-final-actions">
                        <a href={appUrl} className="home-button home-button-primary">
                            Studio 열기 <span aria-hidden="true">↗</span>
                        </a>
                        <a
                            className="home-button home-button-secondary"
                            href={docsUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            기술 문서 <span aria-hidden="true">↗</span>
                        </a>
                    </div>
                </Reveal>
            </div>
        </section>
    );
}
