import {Link, createFileRoute} from "@tanstack/react-router";
import {BrandIcon, type IconName} from "../brand/marks";
import {Guilloche} from "../brand/Guilloche";
import {Footer, Nav, PayerGas} from "../components/Shell";
import {Reveal} from "../components/Reveal";
import {Dial} from "../landing/Dial";
import {accounts, explorerAddressUrl, explorerTxUrl, refusals, settlements} from "../lib/config";
import {short} from "../lib/dial";

/*
 * Where the vocabulary went.
 *
 * The protocol nouns — caveat, enforcer, redeemDelegations, and the six contract
 * names — used to sit in the running sentences. They are accurate and they are
 * unreadable to anyone who has not already built one of these, which on a landing
 * page means the reader stops at the word instead of at the idea.
 *
 * So the page states the idea in ordinary Korean and every exact name lives in
 * one disclosure per section, closed by default, plus the technical notes. The
 * detail is not softened or dropped — a judge who wants the contract that
 * enforces the cap is two clicks from it. It just is not the first thing a
 * visitor has to parse.
 */
const DOCS = "https://github.com/kooroot/Mapae/blob/main/docs/tech-notes.md";

function TechDetails({summary, children}: {summary: string; children: React.ReactNode}) {
    return (
        <details className="tech">
            <summary>{summary}</summary>
            <div className="tech-body">
                {children}
                <a className="mono-link" href={DOCS} target="_blank" rel="noreferrer noopener">
                    기술 문서 전체 보기
                </a>
            </div>
        </details>
    );
}

export const Route = createFileRoute("/")({component: Landing});

function Landing() {
    return (
        <>
            <Nav />
            <main>
                <Hero />
                <Ledger />
                <Numbers />
                <Refused />
                <HowItWorks />
                <OneCall />
                <Comparison />
                <Engraved />
                <Evidence />
            </main>
            <Footer />
        </>
    );
}

/*
 * The hero is off-axis on purpose.
 *
 * Copy holds the left, the object sits right and is pulled down so it crosses
 * the ledger strip below it — the medallion rises into the page rather than
 * being photographed flat inside a section. A centred stack of headline, subhead,
 * button, image is the composition every generated page arrives at, and it reads
 * as one.
 *
 * The headline states a substitution, because substitution is the product: the
 * agent stops holding a key and starts holding a limit. It deliberately does not
 * open with the word 마패 — that arrives in the next sentence with its
 * explanation attached, which is how a loanword earns its place.
 */
function Hero() {
    return (
        <section className="hero">
            <Guilloche size={1180} rings={5} seed={2} className="hero-field" />
            <div className="wrap hero-grid">
                <div className="hero-copy">
                    <Reveal>
                        <span className="eyebrow">x402 · GIWA SEPOLIA</span>
                        <h1 className="display-1">
                            에이전트에게 <span className="dim">지갑이 아니라</span> 한도를 준다
                        </h1>
                    </Reveal>
                    <Reveal delay={90}>
                        <p className="body-lg hero-sub">
                            마패에 새겨진 말의 수는, 권한이 끝나는 지점이었습니다. Mapae는 그 새김을
                            체인에 옮깁니다. 한도를 넘는 결제는 거절되는 것이 아니라 아예 일어나지
                            않고, 수수료는 지갑 주인이 내지 않습니다.
                        </p>
                        <div className="hero-cta">
                            <Link to="/app" className="btn">
                                <span>콘솔 열기</span>
                            </Link>
                            <a className="ghost" href="#how">
                                작동 방식 보기
                            </a>
                        </div>
                    </Reveal>
                </div>
                <div className="hero-object">
                    <Dial />
                </div>
            </div>
        </section>
    );
}

/*
 * A register strip, full-bleed and double-ruled. The hashes scrolling through it
 * are the actual settlements — the page's evidence is present in the first
 * screen rather than filed at the bottom, and it is moving because a ledger is
 * a thing that keeps going.
 */
function Ledger() {
    const entries = [
        ...settlements.map((s) => ({label: s.label, value: short(s.hash)})),
        {label: "결제 지갑 수수료", value: "0 ETH"},
        {label: "체인에 새긴 한도", value: "3 mUSDC / 60초"},
        {label: "네트워크", value: "GIWA Sepolia · eip155:91342"},
    ];
    return (
        <div className="ledger">
            <div className="wrap ledger-inner">
                <span className="micro" style={{flex: "none"}}>
                    ON CHAIN
                </span>
                <div className="ticker">
                    {/* The track is duplicated so the -50% translate loops with no
                        seam. Halving the content would show the gap instead. */}
                    <div className="ticker-track" aria-hidden="true">
                        {[...entries, ...entries].map((entry, index) => (
                            <span className="ticker-item" key={index}>
                                {entry.label} <b>{entry.value}</b>
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

/*
 * Three numerals on a stepped grid rather than three equal cards. The zero is
 * the best number on the page — it is memorable, it is the product's central
 * claim, and it is fetched from the chain rather than typed here.
 */
function Numbers() {
    return (
        <section className="wrap numbers">
            <Reveal className="plate stat">
                <span className="eyebrow">결제 지갑이 가진 수수료</span>
                <PayerGas />
                <p className="label" style={{marginTop: 10}}>
                    돈을 쥔 지갑이 수수료는 한 푼도 들고 있지 않습니다. 대신 내주는 서버가
                    있습니다.
                </p>
                <a
                    className="mono-link"
                    href={explorerAddressUrl(accounts.payer)}
                    target="_blank"
                    rel="noreferrer noopener"
                >
                    {short(accounts.payer)}
                </a>
            </Reveal>
            <Reveal className="plate stat" delay={110}>
                <span className="eyebrow">체인에 새긴 한도</span>
                <span className="numeral">
                    3<span className="numeral-unit">mUSDC / 60초</span>
                </span>
                <p className="label" style={{marginTop: 10}}>
                    60초마다 초기화되는 상한. 서버 설정이 아니라 체인에 적힌 값이라, 넘기면
                    체인이 막습니다.
                </p>
            </Reveal>
            <Reveal className="plate stat" delay={220}>
                <span className="eyebrow">사람이 서명하는 횟수</span>
                <span className="numeral">
                    1<span className="numeral-unit">회</span>
                </span>
                <p className="label" style={{marginTop: 10}}>
                    처음 한 번만 승인하면 끝. 이후 결제는 에이전트가 그 한도 안에서 알아서
                    합니다.
                </p>
            </Reveal>
        </section>
    );
}

/*
 * The refusal band, and the only obsidian surface on the site.
 *
 * Not one site in this product's competitive set shows a rejection — they show
 * throughput, latency and integrations. The refusal is the differentiator, so it
 * sits above the explanation rather than in a FAQ.
 */
function Refused() {
    return (
        <section className="refusals" id="refusals">
            <Guilloche size={920} rings={3} seed={7} className="refusals-field" />
            <div className="wrap">
                <Reveal>
                    <span className="eyebrow">거절</span>
                    <h2 className="h2">
                        한도를 넘긴 결제는{" "}
                        <span style={{color: "var(--red-on-dark)"}}>아예 일어나지 않는다</span>
                    </h2>
                    <p
                        className="body"
                        style={{color: "var(--on-obsidian-dim)", maxWidth: "58ch", marginTop: 18}}
                    >
                        결제는 체인에 올리기 전에 먼저 그대로 돌려봅니다. 거기서 걸리면 그걸로
                        끝입니다 — 실패한 기록조차 남지 않고, 수수료도 쓰이지 않고, 잔고는
                        그대로입니다. 보여드릴 해시가 없다는 것이 오히려 증거입니다.
                    </p>
                </Reveal>
                <div className="refusal-table">
                    {refusals.map((r, index) => (
                        <Reveal key={r.revert + r.enforcer} delay={index * 90}>
                            <div className="refusal-row">
                                <span className="attempt">{r.attempt}</span>
                                <span className="revert">{r.revert}</span>
                            </div>
                        </Reveal>
                    ))}
                </div>
                <Reveal delay={260}>
                    <TechDetails summary="어떤 계약이 막았는지 보기">
                        <dl className="tech-map">
                            {refusals.map((r) => (
                                <div key={r.enforcer}>
                                    <dt>{r.attempt}</dt>
                                    <dd>{r.enforcer}</dd>
                                </div>
                            ))}
                        </dl>
                    </TechDetails>
                </Reveal>
            </div>
        </section>
    );
}

const STEPS: {icon: IconName; body: React.ReactNode; branch?: "refuse"}[] = [
    {
        icon: "gate-402",
        body: (
            <>
                에이전트가 유료 자료를 요청하면, 서버가{" "}
                <code className="value">402 결제가 필요합니다</code>와 가격을 돌려줍니다.
            </>
        ),
    },
    {
        icon: "credential-token",
        body: (
            <>
                에이전트가 이 결제 한 건에만 쓰이는 허가증을 만듭니다. 금액과 받는 사람이 거기
                박힙니다.
            </>
        ),
    },
    {
        icon: "auto-approval",
        body: (
            <>
                결제를 체인에 올리기 전에, 올릴 그 내용 그대로 한 번 돌려봅니다.
            </>
        ),
    },
    {
        icon: "shielded-pass",
        branch: "refuse",
        body: (
            <>
                체인이 새겨둔 조건을 확인합니다. 금액·기간·받는 사람 중 하나라도 어긋나면 여기서
                멈추고, <strong>체인에는 아무것도 올라가지 않습니다</strong>.
            </>
        ),
    },
    {
        icon: "autonomous-settlement",
        body: (
            <>
                통과하면 대신 내주는 서버가 결제를 올리고 수수료까지 냅니다. 지갑 주인은 서명도
                수수료도 하지 않습니다.
            </>
        ),
    },
    {
        icon: "paid-access-stamp",
        body: <>정산이 끝나면 서버가 자료를 내줍니다. 영수증은 거래 기록 그 자체입니다.</>,
    },
];

function HowItWorks() {
    return (
        <section className="band band-ruled" id="how">
            <div className="wrap-narrow">
                <Reveal>
                    <span className="eyebrow">작동 방식</span>
                    <h2 className="h2">
                        x402는 기계가 <span className="dim">어떻게</span> 지불하는지를 정한다.
                        마패는 <span className="dim">얼마까지</span>인지를 정한다.
                    </h2>
                    <p className="body" style={{marginTop: 18, maxWidth: "var(--measure)"}}>
                        새로 외울 단어는 없습니다. 한도를 한 번 정해두면, 그 다음부터는 체인이
                        그 한도를 지킵니다.
                    </p>
                </Reveal>
                <div className="steps">
                    {STEPS.map((step, index) => (
                        <Reveal key={index} delay={index * 60}>
                            <div className="step" data-branch={step.branch}>
                                <BrandIcon name={step.icon} size={38} className="step-icon" />
                                <p className="body" style={{color: "var(--ink)"}}>
                                    {step.body}
                                </p>
                            </div>
                        </Reveal>
                    ))}
                </div>
            </div>
        </section>
    );
}

function OneCall() {
    return (
        <section className="band">
            <div className="wrap-narrow">
                <Reveal>
                    <span className="eyebrow">한 번의 호출</span>
                    <h2 className="h2">사람이 끼어들 자리가 없다</h2>
                    <div className="code">
                        <pre>
                            <span className="c">
                                {"// MCP 도구 하나. 승인 창도, 붙여넣기도 없다."}
                            </span>
                            {"\n"}
                            {"mapae_pay_for_resource({\n"}
                            {'  url: "https://seller.example/deliverable/inv-001"\n'}
                            {"})\n\n"}
                            <span className="c">{"// → { settled: true,"}</span>
                            {"\n"}
                            <span className="c">{"//     transaction: "}</span>
                            <span className="s">{'"0x533c5cb2…fd9964c"'}</span>
                            <span className="c">{","}</span>
                            {"\n"}
                            <span className="c">{"//     payerGasSpend: "}</span>
                            <span className="s">0</span>
                            <span className="c">{" }"}</span>
                        </pre>
                    </div>
                    <p className="label" style={{marginTop: 16}}>
                        위 기록은 실제로 GIWA Sepolia에 올라간 결제입니다.{" "}
                        <a
                            className="mono-link"
                            href={explorerTxUrl(settlements[2].hash)}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            탐색기에서 확인
                        </a>
                    </p>
                </Reveal>
            </div>
        </section>
    );
}

function Comparison() {
    return (
        <section className="band band-ruled">
            <div className="wrap">
                <Reveal>
                    <span className="eyebrow">차이</span>
                    <h2 className="h2">권한은 새겨진 곳에서 끝난다</h2>
                </Reveal>
                <Reveal delay={80}>
                    <div className="compare">
                        <div className="compare-col">
                            <h3 className="h3 dim">지금까지</h3>
                            <ol>
                                <li>에이전트에게 키를 준다</li>
                                <li>백엔드가 한도를 확인한다</li>
                                <li>코드가 약속을 지키기를 믿는다</li>
                                <li>초과분은 사후에 발견된다</li>
                            </ol>
                        </div>
                        <div className="compare-col">
                            <h3 className="h3">마패</h3>
                            <ol>
                                <li>처음 한 번만 승인한다</li>
                                <li>결제마다 1회용 허가증을 만든다</li>
                                <li data-mark="chain">체인이 막는다</li>
                                <li>초과분은 애초에 실리지 않는다</li>
                            </ol>
                        </div>
                    </div>
                </Reveal>
            </div>
        </section>
    );
}

const TERMS = [
    ["한 주기에 쓸 수 있는 금액", "3.000000 mUSDC", "ERC20PeriodTransferEnforcer"],
    ["주기가 초기화되는 간격", "60초", "ERC20PeriodTransferEnforcer"],
    ["권한이 살아 있는 기간", "시작 · 만료 시각", "TimestampEnforcer"],
    ["결제를 올릴 수 있는 곳", "지정된 한 곳만", "RedeemerEnforcer"],
    ["결제 한 건의 금액과 상대", "결제마다 고정", "ERC20TransferAmountEnforcer"],
    ["권한 회수", "서명 한 번", "DelegationManager"],
] as const;

function Engraved() {
    return (
        <section className="band" id="engraved">
            <div className="wrap">
                <Reveal>
                    <span className="eyebrow">새겨진 것</span>
                    <h2 className="h2">한도는 설정값이 아니라 체인에 적힌 값이다</h2>
                    <p className="body" style={{marginTop: 18, maxWidth: "var(--measure)"}}>
                        아래 값은 전부 체인에 올라가 있고, 결제 직전에 체인이 직접 읽습니다. 우리가
                        지키겠다고 적어둔 약속이 아닙니다.
                    </p>
                </Reveal>
                <Reveal delay={80}>
                    <div className="table-scroll plate">
                        <table className="params">
                            <thead>
                                <tr>
                                    <th>항목</th>
                                    <th>값</th>
                                </tr>
                            </thead>
                            <tbody>
                                {TERMS.map(([k, v]) => (
                                    <tr key={k}>
                                        <td className="k">{k}</td>
                                        <td className="v">{v}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Reveal>
                <Reveal delay={110}>
                    <TechDetails summary="각 항목을 검사하는 컨트랙트 보기">
                        <dl className="tech-map">
                            {TERMS.map(([k, , who]) => (
                                <div key={k}>
                                    <dt>{k}</dt>
                                    <dd>{who}</dd>
                                </div>
                            ))}
                        </dl>
                    </TechDetails>
                </Reveal>
                <Reveal delay={140}>
                    <div className="notice">
                        <BrandIcon name="agent-route" size={34} />
                        <p className="body" style={{color: "var(--ink)"}}>
                            <strong>만료를 기다릴 필요가 없습니다.</strong> 언제든 서명 한 번으로
                            권한을 끝낼 수 있고, 그 즉시 같은 허가증으로는 아무것도 결제되지
                            않습니다.
                        </p>
                    </div>
                </Reveal>
            </div>
        </section>
    );
}

function Evidence() {
    const rows = [
        ...settlements.map((s) => ({label: s.label, href: explorerTxUrl(s.hash), text: short(s.hash)})),
        {
            label: "결제 지갑",
            href: explorerAddressUrl(accounts.payer),
            text: short(accounts.payer),
        },
        {
            label: "결제 자산 (mUSDC)",
            href: explorerAddressUrl(accounts.token),
            text: short(accounts.token),
        },
    ];
    return (
        <section className="band band-ruled" id="evidence">
            <div className="wrap-narrow">
                <Reveal>
                    <span className="eyebrow">증거</span>
                    <h2 className="h2">전부 열어볼 수 있다</h2>
                </Reveal>
                <div className="evidence">
                    {rows.map((row, index) => (
                        <Reveal key={row.href} delay={index * 55}>
                            <div className="evidence-row">
                                <span className="small" style={{color: "var(--ink)"}}>
                                    {row.label}
                                </span>
                                <a
                                    className="mono-link"
                                    href={row.href}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                >
                                    {row.text}
                                </a>
                            </div>
                        </Reveal>
                    ))}
                </div>
                <Reveal delay={80}>
                    <div className="notice">
                        <BrandIcon name="verified-credential" size={34} />
                        <p className="body" style={{color: "var(--ink)"}}>
                            <strong>테스트넷입니다.</strong> GIWA Sepolia 위에서 테스트 자산으로만
                            동작하며, 실제 가치를 가진 자산에는 아직 쓰지 않습니다.
                        </p>
                    </div>
                </Reveal>
            </div>
        </section>
    );
}
