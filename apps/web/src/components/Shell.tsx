import {Link} from "@tanstack/react-router";
import {Lockup, PassEmblem, Tagline, Wordmark} from "../brand/marks";
import {appUrl, docsUrl} from "../lib/config";

export function Nav({variant = "paper"}: {variant?: "paper" | "dark"}) {
    return (
        <header className={`nav nav-${variant}`}>
            <div className="wrap nav-inner">
                <Link to="/" aria-label="Mapae 홈">
                    <Lockup />
                </Link>
                <nav className="nav-links">
                    <a href="/#authority">제품</a>
                    <a href="/#boundaries">권한 경계</a>
                    <a href="/#security">보안</a>
                    <a href="/#evidence">증거</a>
                    <a href={docsUrl} target="_blank" rel="noreferrer noopener">
                        문서
                    </a>
                </nav>
                <a href={appUrl} className="btn">
                    <span>Studio 열기</span>
                    <span aria-hidden="true">↗</span>
                </a>
            </div>
        </header>
    );
}

export function Footer({variant = "paper"}: {variant?: "paper" | "dark"}) {
    return (
        <footer className={`foot foot-${variant}`}>
            <div className="wrap foot-inner">
                <div>
                    <span className="lockup">
                        <PassEmblem size={34} />
                        <Wordmark height={19} />
                    </span>
                    <Tagline />
                    <p className="label foot-motto">
                        마패는 특권의 증표가 아니라{" "}
                        <span style={{color: "var(--ink)"}}>한계의 증표다</span>. 새겨진 말의 수는
                        권한이 끝나는 지점이었다.
                    </p>
                </div>
                <div className="label foot-meta">
                    <p>GIWA Sepolia · eip155:91342</p>
                    <p>테스트넷 자산으로만 동작합니다.</p>
                </div>
            </div>
        </footer>
    );
}
