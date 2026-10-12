import {Dialog} from "@base-ui/react/dialog";
import {Menu, X} from "lucide-react";
import "./brand-controls.css";
import {Lockup, PassEmblem, Tagline, Wordmark} from "../brand/marks";
import {appUrl, docsUrl, faucetUrl, githubUrl, sellerGuideUrl} from "../lib/config";
import {localizePath, localizeUrl, type Locale} from "../lib/i18n";
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
        arcade: string;
        faucet: string;
        docs: string;
        sellerGuide: string;
        githubAria: string;
        openStudio: string;
        menuOpen: string;
        menuClose: string;
        menuTitle: string;
        menuDescription: string;
        menuAria: string;
        footNavAria: string;
        mottoLead: string;
        mottoMark: string;
        mottoTail: string;
        network: string;
        testnetOnly: string;
    }
> = {
    en: {
        homeAria: "Mapae home",
        product: "Product",
        boundaries: "Boundaries",
        security: "Security",
        evidence: "Evidence",
        arcade: "Arcade",
        faucet: "Test tokens",
        docs: "Docs",
        sellerGuide: "Seller guide",
        githubAria: "Open the Mapae GitHub repository",
        openStudio: "Open Studio",
        menuOpen: "Open menu",
        menuClose: "Close menu",
        menuTitle: "Explore Mapae",
        menuDescription: "Product, security, arcade and documentation",
        menuAria: "Mobile navigation",
        footNavAria: "Footer navigation",
        mottoLead: "The Mapae was not a token of privilege — it was ",
        mottoMark: "a token of limits",
        mottoTail: ". The engraved horse count was where the authority ended.",
        network: "GIWA Sepolia testnet",
        testnetOnly: "Operates on testnet assets only.",
    },
    ko: {
        homeAria: "Mapae 홈",
        product: "제품",
        boundaries: "권한 경계",
        security: "보안",
        evidence: "증거",
        arcade: "오락실",
        faucet: "테스트 토큰",
        docs: "문서",
        sellerGuide: "셀러 가이드",
        githubAria: "Mapae GitHub 저장소 열기",
        openStudio: "Studio 열기",
        menuOpen: "메뉴 열기",
        menuClose: "메뉴 닫기",
        menuTitle: "어디로 갈까요?",
        menuDescription: "제품, 보안, 오락실과 문서로 이동",
        menuAria: "모바일 메뉴",
        footNavAria: "바닥글 메뉴",
        mottoLead: "마패는 특권의 증표가 아니라 ",
        mottoMark: "한계의 증표다",
        mottoTail: ". 새겨진 말의 수는 권한이 끝나는 지점이었다.",
        network: "GIWA Sepolia 테스트넷",
        testnetOnly: "테스트넷 자산으로만 동작합니다.",
    },
};

type NavLink = {href: string; label: string; external?: boolean};

/** Links that leave the landing carry the ↗ mark; in-page anchors do not. */
function sectionLinks(locale: Locale): NavLink[] {
    const t = COPY[locale];
    const home = localizePath("/", locale);
    return [
        {href: `${home}#authority`, label: t.product},
        {href: `${home}#boundaries`, label: t.boundaries},
        {href: `${home}#security`, label: t.security},
        {href: `${home}#evidence`, label: t.evidence},
    ];
}

function outboundLinks(locale: Locale): {arcade: NavLink; faucet: NavLink; docs: NavLink; github: NavLink} {
    const t = COPY[locale];
    return {
        arcade: {href: localizePath("/arcade", locale), label: t.arcade, external: true},
        faucet: {href: localizeUrl(faucetUrl, locale), label: t.faucet, external: true},
        docs: {href: locale === "ko" ? `${docsUrl}/readme.ko` : docsUrl, label: t.docs, external: true},
        github: {href: githubUrl, label: "GitHub", external: true},
    };
}

/** Mapae's own surfaces (the arcade, Studio, the faucet) open in place; other origins open in a new tab. */
function targetProps(href: string) {
    const own = [appUrl, faucetUrl].map(url => url.replace(/\/$/, ""));
    return href.startsWith("/") || own.some(url => href.startsWith(url)) ? {} : {target: "_blank", rel: "noreferrer noopener"};
}

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

export function Nav() {
    const {locale} = useLocale();
    const t = COPY[locale];
    const {arcade, faucet, docs, github} = outboundLinks(locale);
    const menu = [...sectionLinks(locale), arcade, faucet, docs, github];
    return (
        <header className="nav">
            <div className="wrap nav-inner">
                <a className="nav-home" href={localizePath("/", locale)} aria-label={t.homeAria}>
                    <Lockup />
                </a>
                <nav className="nav-links">
                    {sectionLinks(locale).map(link => <a key={link.href} href={link.href}>{link.label}</a>)}
                    <a className="nav-arcade" href={arcade.href}>{arcade.label}<span aria-hidden="true">↗</span></a>
                    <a href={docs.href} {...targetProps(docs.href)}>{docs.label}</a>
                </nav>
                <div className="nav-actions">
                    <LocaleSwitch />
                    <Dialog.Root>
                        <Dialog.Trigger className="nav-menu-toggle" aria-label={t.menuOpen}><Menu size={21} aria-hidden="true" /></Dialog.Trigger>
                        <Dialog.Portal>
                            <Dialog.Backdrop className="mapae-dialog-backdrop" />
                            <Dialog.Popup className="mapae-confirm nav-menu-popup">
                                <div className="nav-menu-top">
                                    <Dialog.Title>{t.menuTitle}</Dialog.Title>
                                    <Dialog.Close className="mapae-icon-button" aria-label={t.menuClose}><X size={22} aria-hidden="true" /></Dialog.Close>
                                </div>
                                <Dialog.Description className="sr-only">{t.menuDescription}</Dialog.Description>
                                <nav aria-label={t.menuAria}>
                                    {menu.map(link => (
                                        <Dialog.Close key={link.href} nativeButton={false} render={<a href={link.href} {...targetProps(link.href)} />}>
                                            {link.label}
                                            {link.external && <span aria-hidden="true">↗</span>}
                                        </Dialog.Close>
                                    ))}
                                </nav>
                                <a className="nav-menu-cta" href={localizeUrl(appUrl, locale)}>
                                    {t.openStudio}
                                    <span aria-hidden="true">↗</span>
                                </a>
                            </Dialog.Popup>
                        </Dialog.Portal>
                    </Dialog.Root>
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
                    <a href={localizeUrl(appUrl, locale)} className="btn">
                        <span>{t.openStudio}</span>
                        <span aria-hidden="true">↗</span>
                    </a>
                </div>
            </div>
        </header>
    );
}

export function Footer() {
    const {locale} = useLocale();
    const t = COPY[locale];
    const {arcade, faucet, docs, github} = outboundLinks(locale);
    const links: NavLink[] = [
        {href: localizeUrl(appUrl, locale), label: "Studio"},
        faucet,
        {href: sellerGuideUrl, label: t.sellerGuide, external: true},
        docs,
        arcade,
        github,
    ];
    return (
        <footer className="foot">
            <div className="wrap foot-inner">
                <div>
                    <span className="lockup">
                        <PassEmblem size={34} />
                        <Wordmark height={19} />
                    </span>
                    <Tagline />
                    <p className="label foot-motto">
                        {t.mottoLead}
                        <span>{t.mottoMark}</span>
                        {t.mottoTail}
                    </p>
                </div>
                <nav className="foot-links" aria-label={t.footNavAria}>
                    {links.map(link => (
                        <a key={link.href} href={link.href} {...targetProps(link.href)}>
                            {link.label}
                            {link.external && <span aria-hidden="true">↗</span>}
                        </a>
                    ))}
                </nav>
                <div className="label foot-meta">
                    <p title="eip155:91342">{t.network}</p>
                    <p>{t.testnetOnly}</p>
                    <LocaleSwitch />
                </div>
            </div>
        </footer>
    );
}
