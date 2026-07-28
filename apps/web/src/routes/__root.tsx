import {HeadContent, Scripts, createRootRoute} from "@tanstack/react-router";
import type {ReactNode} from "react";
import {appUrl, landingUrl, siteSurface} from "../lib/config";

import "../styles/fonts.css";
import "../styles/tokens.css";
import "../styles/landing.css";
import "../styles/hero.css";
import "../styles/home.css";
import "../styles/app.css";

// Cloudflare's public/_headers file covers static assets, while TanStack owns
// the SSR document response. The request-specific CSP is attached in
// `src/server.ts`, where the header can use the same nonce as TanStack's
// streaming bootstrap.
const DOCUMENT_SECURITY_HEADERS = {
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy":
        "geolocation=(), microphone=(), camera=(), payment=()",
};

/*
 * The document.
 *
 * `lang="ko"` is load-bearing rather than metadata. This page mixes Hangul,
 * Hanja and Latin in the same sentence, and the language tag is what decides
 * which glyph a browser picks for the codepoints Chinese and Japanese share with
 * Korean — 馬 renders differently under `lang="ja"`. It also drives `word-break:
 * keep-all`, which is the difference between Korean lines that break between
 * words and Korean lines that break mid-word.
 */

export const Route = createRootRoute({
    headers: () => DOCUMENT_SECURITY_HEADERS,
    head: () => {
        const isApp = siteSurface === "app";
        const title = isApp
            ? "Mapae Studio — Delegated payment control"
            : "Mapae — Limit the authority. Let the agent act.";
        const description = isApp
            ? "자산·금액·기간·수취인 경계를 지갑으로 승인하고, GIWA에서 에이전트 결제 권한과 정산 상태를 관리합니다."
            : "자산·금액·기간·수취인의 경계를 정하면 AI 에이전트가 그 안에서 x402로 결제합니다. 소유자는 언제든 권한을 회수할 수 있습니다.";

        return {
            meta: [
                {charSet: "utf-8"},
                {name: "viewport", content: "width=device-width, initial-scale=1"},
                {title},
                {name: "description", content: description},
                {name: "theme-color", content: "#050505"},
                {property: "og:title", content: title},
                {property: "og:description", content: description},
                {property: "og:type", content: "website"},
                {property: "og:site_name", content: "Mapae"},
                {property: "og:url", content: isApp ? appUrl : landingUrl},
                {
                    property: "og:image",
                    content: `${landingUrl.replace(/\/$/, "")}/og-hero-v2.png`,
                },
                {property: "og:image:type", content: "image/png"},
                {property: "og:image:width", content: "1200"},
                {property: "og:image:height", content: "630"},
                {
                    property: "og:image:alt",
                    content:
                        "A bronze Mapae authority pass held inside owner-defined payment boundaries.",
                },
                {name: "twitter:card", content: "summary_large_image"},
                {name: "twitter:title", content: title},
                {name: "twitter:description", content: description},
                {
                    name: "twitter:image",
                    content: `${landingUrl.replace(/\/$/, "")}/og-hero-v2.png`,
                },
                {
                    name: "twitter:image:alt",
                    content:
                        "A bronze Mapae authority pass held inside owner-defined payment boundaries.",
                },
            ],
            links: [
                {
                    rel: "canonical",
                    href: isApp ? appUrl : landingUrl,
                },
                {
                    rel: "icon",
                    href: "/favicon.ico",
                    sizes: "any",
                },
                {
                    rel: "icon",
                    href: "/favicon.png",
                    type: "image/png",
                    sizes: "192x192",
                },
                {
                    rel: "apple-touch-icon",
                    href: "/favicon.png",
                    sizes: "192x192",
                },
                // Preconnect, not preload: the RPC host is contacted only by routes
                // that read the chain, and a preload of a request that never happens
                // is a warning in every console that opens this page.
                {rel: "preconnect", href: "https://sepolia-rpc.giwa.io"},
            ],
        };
    },
    shellComponent: RootDocument,
});

function RootDocument({children}: {children: ReactNode}) {
    return (
        <html lang="ko">
            <head>
                <HeadContent />
            </head>
            <body>
                {children}
                <Scripts />
            </body>
        </html>
    );
}
