import {Link} from "@tanstack/react-router";
import {Lockup, PassEmblem, Tagline, Wordmark} from "../brand/marks";
import {appUrl, docsUrl, githubUrl} from "../lib/config";

function GitHubMark() {
    return (
        <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
        >
            <path
                fill="currentColor"
                d="M12 .3a12 12 0 0 0-3.79 23.4c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.28-1.23 3.28-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.21.69.83.57A12 12 0 0 0 12 .3Z"
            />
        </svg>
    );
}

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
                <div className="nav-actions">
                    <a
                        href={githubUrl}
                        className="nav-github"
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label="Mapae GitHub 저장소 열기"
                    >
                        <GitHubMark />
                        <span>GitHub</span>
                    </a>
                    <a href={appUrl} className="btn">
                        <span>Studio 열기</span>
                        <span aria-hidden="true">↗</span>
                    </a>
                </div>
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
