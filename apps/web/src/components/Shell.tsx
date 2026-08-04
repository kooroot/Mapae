import {Link} from "@tanstack/react-router";
import {Lockup, PassEmblem, Tagline, Wordmark} from "../brand/marks";
import {appUrl, docsUrl, githubUrl} from "../lib/config";
import type {Locale} from "../lib/i18n";
import {LocaleSwitch, useLocale} from "../lib/locale";

/*
 * The bilingual-copy pattern every ported component follows: one `COPY` object per
 * component, `en` first because English is the base, the JSX untouched apart from
 * reading it. Copy lives next to the markup that renders it — a central catalogue
 * would turn every copy edit into a two-file change and invite keys to drift from
 * their usage.
 */
const COPY: Record<
    Locale,
    {
        homeAria: string;
        product: string;
        boundaries: string;
        security: string;
        evidence: string;
        docs: string;
        githubAria: string;
        openStudio: string;
        mottoLead: string;
        mottoMark: string;
        mottoTail: string;
        testnetOnly: string;
    }
> = {
    en: {
        homeAria: "Mapae home",
        product: "Product",
        boundaries: "Boundaries",
        security: "Security",
        evidence: "Evidence",
        docs: "Docs",
        githubAria: "Open the Mapae GitHub repository",
        openStudio: "Open Studio",
        mottoLead: "The Mapae was not a token of privilege — it was ",
        mottoMark: "a token of limits",
        mottoTail: ". The engraved horse count was where the authority ended.",
        testnetOnly: "Operates on testnet assets only.",
    },
    ko: {
        homeAria: "Mapae 홈",
        product: "제품",
        boundaries: "권한 경계",
        security: "보안",
        evidence: "증거",
        docs: "문서",
        githubAria: "Mapae GitHub 저장소 열기",
        openStudio: "Studio 열기",
        mottoLead: "마패는 특권의 증표가 아니라 ",
        mottoMark: "한계의 증표다",
        mottoTail: ". 새겨진 말의 수는 권한이 끝나는 지점이었다.",
        testnetOnly: "테스트넷 자산으로만 동작합니다.",
    },
};

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
    const {locale} = useLocale();
    const t = COPY[locale];
    return (
        <header className={`nav nav-${variant}`}>
            <div className="wrap nav-inner">
                <Link to="/" aria-label={t.homeAria}>
                    <Lockup />
                </Link>
                <nav className="nav-links">
                    <a href="/#authority">{t.product}</a>
                    <a href="/#boundaries">{t.boundaries}</a>
                    <a href="/#security">{t.security}</a>
                    <a href="/#evidence">{t.evidence}</a>
                    <a href={docsUrl} target="_blank" rel="noreferrer noopener">
                        {t.docs}
                    </a>
                </nav>
                <div className="nav-actions">
                    <LocaleSwitch />
                    <a
                        href={githubUrl}
                        className="nav-github"
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label={t.githubAria}
                    >
                        <GitHubMark />
                        <span>GitHub</span>
                    </a>
                    <a href={appUrl} className="btn">
                        <span>{t.openStudio}</span>
                        <span aria-hidden="true">↗</span>
                    </a>
                </div>
            </div>
        </header>
    );
}

export function Footer({variant = "paper"}: {variant?: "paper" | "dark"}) {
    const {locale} = useLocale();
    const t = COPY[locale];
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
                        {t.mottoLead}
                        <span style={{color: "var(--ink)"}}>{t.mottoMark}</span>
                        {t.mottoTail}
                    </p>
                </div>
                <div className="label foot-meta">
                    <p>GIWA Sepolia · eip155:91342</p>
                    <p>{t.testnetOnly}</p>
                </div>
            </div>
        </footer>
    );
}
