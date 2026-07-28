import {Link, createFileRoute} from "@tanstack/react-router";
import {Footer, Nav, PayerGas} from "../components/Shell";
import {Dial} from "../landing/Dial";
import {explorerAddressUrl, explorerTxUrl, accounts, refusals, settlements} from "../lib/config";
import {short} from "../lib/dial";

export const Route = createFileRoute("/")({component: Landing});

function Landing() {
    return (
        <>
            <Nav />
            <main>
                <Hero />
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
 * The hero states a substitution, because substitution is literally the product:
 * the agent stops holding a key and starts holding a limit. It deliberately does
 * not open with the word 마패 — that arrives one line down with its explanation
 * attached, which is how a loanword earns its place instead of being decorative.
 */
function Hero() {
    return (
        <section className="hero">
            <div className="wrap hero-copy rise">
                <span className="eyebrow">x402 · ERC-7710 · GIWA SEPOLIA</span>
                <h1 className="display-1">
                    에이전트에게 <span className="dim">지갑이 아니라</span> 한도를 준다
                </h1>
                <p className="body-lg hero-sub">
                    마패에 새겨진 말의 수는 권한이 끝나는 지점이었다. Mapae는 그 새김을 온체인
                    caveat으로 옮긴다 — 한도를 넘는 결제는 서버가 아니라 인포서 컨트랙트가
                    되돌리고, 지불자는 가스를 한 번도 만지지 않는다.
                </p>
                <div className="hero-cta">
                    <Link to="/app" className="btn">
                        콘솔 열기
                    </Link>
                    <a className="ghost" href="#how">
                        작동 방식 보기
                    </a>
                </div>
                <Dial />
            </div>
        </section>
    );
}

/*
 * Three numerals, placed before any explanation. The zero is the best one on the
 * page: it is memorable, it is the product claim, and it is fetched rather than
 * asserted.
 */
function Numbers() {
    return (
        <section className="numbers">
            <div>
                <span className="eyebrow">지불자가 보유한 가스</span>
                <PayerGas />
                <p className="label" style={{marginTop: 8}}>
                    자금을 쥔 계정이 가스는 한 푼도 들고 있지 않다. 릴레이어가 전부 낸다.{" "}
                    <a
                        className="mono-link"
                        href={explorerAddressUrl(accounts.payer)}
                        target="_blank"
                        rel="noreferrer noopener"
                    >
                        {short(accounts.payer)}
                    </a>
                </p>
            </div>
            <div>
                <span className="eyebrow">온체인 한도</span>
                <span className="numeral">
                    3<span className="numeral-unit">mUSDC / 60초</span>
                </span>
                <p className="label" style={{marginTop: 8}}>
                    주기마다 초기화되는 상한. 백엔드 설정이 아니라 caveat의 항이며, 넘기면
                    체인이 되돌린다.
                </p>
            </div>
            <div>
                <span className="eyebrow">사람이 서명하는 횟수</span>
                <span className="numeral">
                    1<span className="numeral-unit">회</span>
                </span>
                <p className="label" style={{marginTop: 8}}>
                    루트 권한을 한 번 서명하면 끝. 이후 결제마다 에이전트가 그 아래로 리프를
                    만들어 쓴다.
                </p>
            </div>
        </section>
    );
}

/*
 * The refusal band, and the only obsidian surface on the site.
 *
 * Not one reference site in this product's competitive set shows a rejection —
 * they show throughput, latency and integrations. A refusal is the differentiator
 * and it belongs above the explanation, not in a FAQ.
 */
function Refused() {
    return (
        <section className="refusals" id="refusals">
            <div className="wrap">
                <span className="eyebrow">거절</span>
                <h2 className="h2">
                    한도를 넘긴 결제는 <span style={{color: "var(--red-on-dark)"}}>트랜잭션이
                    되지도 못한다</span>
                </h2>
                <p className="body" style={{color: "var(--on-obsidian-dim)", maxWidth: "58ch", marginTop: 16}}>
                    결제는 브로드캐스트 전에 시뮬레이션된다. 인포서가 거절하면 거기서 끝이라
                    체인에 아무것도 실리지 않는다 — 되돌린 트랜잭션조차 남지 않고, 가스도 쓰이지
                    않으며, 잔고는 움직이지 않는다. 링크할 해시가 없는 이유이자, 되돌림보다 강한
                    주장인 이유다.
                </p>
                <div className="refusal-table">
                    {refusals.map((r) => (
                        <div className="refusal-row" key={r.revert + r.enforcer}>
                            <span className="attempt">{r.attempt}</span>
                            <span className="enforcer">{r.enforcer}</span>
                            <span className="revert">{r.revert}</span>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}

function HowItWorks() {
    return (
        <section className="band" id="how">
            <div className="wrap-narrow">
                <span className="eyebrow">작동 방식</span>
                <h2 className="h2">
                    x402는 기계가 <span className="dim">어떻게</span> 지불하는지를 정한다. 마패는{" "}
                    <span className="dim">얼마까지</span>인지를 정한다.
                </h2>
                <p className="body" style={{marginTop: 16, maxWidth: "var(--measure)"}}>
                    caveat은 체인이 결제를 통과시키기 전에 검사하는 조건이다. 이 흐름에서 새로
                    등장하는 단어는 그것 하나뿐이고, 나머지는 전부 x402의 표준 명사다.
                </p>
                <div className="steps">
                    <Step>
                        에이전트가 유료 리소스를 요청하고, 리소스 서버가{" "}
                        <code className="value">402 Payment Required</code>와 결제 요건을 돌려준다.
                    </Step>
                    <Step>
                        에이전트가 소유자의 루트 권한 아래로 이 결제 하나만을 위한 리프 위임을
                        만들어 서명한다. 금액·수취인이 리프에 박힌다.
                    </Step>
                    <Step>
                        facilitator가 <code className="value">/verify</code>로 시뮬레이션한다. 실제로
                        브로드캐스트될 그 트랜잭션을 그대로 <code className="value">eth_call</code>한다.
                    </Step>
                    <Step branch="refuse">
                        인포서가 caveat을 읽는다. 한도·기간·수취인 중 하나라도 어긋나면 여기서
                        되돌아가고 <strong>브로드캐스트는 일어나지 않는다</strong>.
                    </Step>
                    <Step>
                        통과하면 릴레이어가 <code className="value">redeemDelegations</code>를 보내고
                        가스를 낸다. 지불자 계정은 서명도 가스도 하지 않는다.
                    </Step>
                    <Step>
                        정산이 확정되면 리소스 서버가 자원을 내준다. 영수증은 트랜잭션 해시 그
                        자체다.
                    </Step>
                </div>
            </div>
        </section>
    );
}

function Step({children, branch}: {children: React.ReactNode; branch?: "refuse"}) {
    return (
        <div className="step" data-branch={branch}>
            <p className="body" style={{color: "var(--ink)"}}>
                {children}
            </p>
        </div>
    );
}

function OneCall() {
    return (
        <section className="band">
            <div className="wrap-narrow">
                <span className="eyebrow">한 번의 호출</span>
                <h2 className="h2">사람이 끼어들 자리가 없다</h2>
                <div className="code">
                    <pre>
                        <span className="c">{"// MCP 도구 하나. 승인 창도, 붙여넣기도 없다."}</span>
                        {"\n"}
                        {"mapae_pay_for_resource({\n"}
                        {'  url: "https://seller.example/deliverable/inv-001"\n'}
                        {"})\n\n"}
                        <span className="c">{"// →"}</span>
                        {" { settled: true,\n"}
                        {"//     transaction: "}
                        <span className="s">"0x533c5cb2…fd9964c"</span>
                        {",\n"}
                        {"//     payerGasSpend: "}
                        <span className="s">0</span>
                        {" }"}
                    </pre>
                </div>
                <p className="label" style={{marginTop: 14}}>
                    위 해시는 실제로 GIWA Sepolia에 실린 결제다.{" "}
                    <a
                        className="mono-link"
                        href={explorerTxUrl(settlements[2].hash)}
                        target="_blank"
                        rel="noreferrer noopener"
                    >
                        탐색기에서 확인
                    </a>
                </p>
            </div>
        </section>
    );
}

function Comparison() {
    return (
        <section className="band">
            <div className="wrap">
                <span className="eyebrow">차이</span>
                <h2 className="h2">권한은 새겨진 곳에서 끝난다</h2>
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
                            <li>소유자가 루트 권한을 한 번 서명한다</li>
                            <li>결제마다 그 아래로 리프를 만든다</li>
                            <li data-mark="chain">인포서가 되돌린다</li>
                            <li>초과분은 애초에 실리지 않는다</li>
                        </ol>
                    </div>
                </div>
            </div>
        </section>
    );
}

function Engraved() {
    return (
        <section className="band" id="engraved">
            <div className="wrap">
                <span className="eyebrow">새겨진 것</span>
                <h2 className="h2">한도는 설정값이 아니라 주소가 있는 항이다</h2>
                <p className="body" style={{marginTop: 16, maxWidth: "var(--measure)"}}>
                    아래 항은 전부 배포된 인포서 컨트랙트가 읽는 값이다. 우리가 지키겠다고 적은
                    것이 아니라, 체인이 결제 직전에 검사하는 것이다.
                </p>
                <div className="table-scroll">
                    <table className="params">
                        <thead>
                            <tr>
                                <th>항</th>
                                <th>값</th>
                                <th>검사하는 컨트랙트</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td className="k">주기 한도</td>
                                <td className="v">3.000000 mUSDC</td>
                                <td className="who">ERC20PeriodTransferEnforcer</td>
                            </tr>
                            <tr>
                                <td className="k">주기 길이</td>
                                <td className="v">60초</td>
                                <td className="who">ERC20PeriodTransferEnforcer</td>
                            </tr>
                            <tr>
                                <td className="k">유효 기간</td>
                                <td className="v">개시 · 만료 시각</td>
                                <td className="who">TimestampEnforcer</td>
                            </tr>
                            <tr>
                                <td className="k">상환자</td>
                                <td className="v">facilitator 주소만</td>
                                <td className="who">RedeemerEnforcer</td>
                            </tr>
                            <tr>
                                <td className="k">건별 금액·수취인</td>
                                <td className="v">결제마다 리프에 고정</td>
                                <td className="who">ERC20TransferAmountEnforcer</td>
                            </tr>
                            <tr>
                                <td className="k">회수</td>
                                <td className="v">소유자 서명 한 번</td>
                                <td className="who">DelegationManager</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div className="notice">
                    <p className="body" style={{color: "var(--ink)"}}>
                        <strong>회수는 만료를 기다리지 않는다.</strong> 소유자가 서명 한 번으로
                        권한을 끝낼 수 있고, 그 시점부터 같은 위임으로는 아무것도 결제되지 않는다.
                    </p>
                </div>
            </div>
        </section>
    );
}

function Evidence() {
    return (
        <section className="band" id="evidence">
            <div className="wrap-narrow">
                <span className="eyebrow">증거</span>
                <h2 className="h2">전부 열어볼 수 있다</h2>
                <div className="evidence">
                    {settlements.map((s) => (
                        <div className="evidence-row" key={s.hash}>
                            <span className="small" style={{color: "var(--ink)"}}>
                                {s.label}
                            </span>
                            <a
                                className="mono-link"
                                href={explorerTxUrl(s.hash)}
                                target="_blank"
                                rel="noreferrer noopener"
                            >
                                {short(s.hash)}
                            </a>
                        </div>
                    ))}
                    <div className="evidence-row">
                        <span className="small" style={{color: "var(--ink)"}}>
                            지불자 스마트 계정
                        </span>
                        <a
                            className="mono-link"
                            href={explorerAddressUrl(accounts.payer)}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            {short(accounts.payer)}
                        </a>
                    </div>
                    <div className="evidence-row">
                        <span className="small" style={{color: "var(--ink)"}}>
                            결제 자산 (mUSDC)
                        </span>
                        <a
                            className="mono-link"
                            href={explorerAddressUrl(accounts.token)}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            {short(accounts.token)}
                        </a>
                    </div>
                </div>
                <div className="notice">
                    <p className="body" style={{color: "var(--ink)"}}>
                        <strong>테스트넷입니다.</strong> GIWA Sepolia 위에서 테스트 자산으로만
                        동작하며, 실제 가치를 가진 자산에는 아직 쓰지 않습니다.
                    </p>
                </div>
            </div>
        </section>
    );
}
