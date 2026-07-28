import {HeadContent, Scripts, createRootRoute} from "@tanstack/react-router";
import type {ReactNode} from "react";

import "../styles/fonts.css";
import "../styles/tokens.css";
import "../styles/landing.css";
import "../styles/app.css";

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
    head: () => ({
        meta: [
            {charSet: "utf-8"},
            {name: "viewport", content: "width=device-width, initial-scale=1"},
            {title: "Mapae — 에이전트에게 지갑이 아니라 한도를 준다"},
            {
                name: "description",
                content:
                    "AI 에이전트가 402를 만나 스스로 결제한다. 얼마까지 쓸 수 있는지는 코드의 약속이 아니라 체인이 정한다. GIWA Sepolia.",
            },
            {name: "theme-color", content: "#f2ede2"},
            {property: "og:title", content: "Mapae — Give your agent a limit, not a wallet"},
            {
                property: "og:description",
                content:
                    "An AI agent meets a 402 and pays for itself. How much it may spend is decided by the chain, not promised by the code.",
            },
            {property: "og:type", content: "website"},
            {name: "twitter:card", content: "summary_large_image"},
        ],
        links: [
            {rel: "icon", href: "/favicon.svg", type: "image/svg+xml"},
            // Preconnect, not preload: the RPC host is contacted only by routes
            // that read the chain, and a preload of a request that never happens
            // is a warning in every console that opens this page.
            {rel: "preconnect", href: "https://sepolia-rpc.giwa.io"},
        ],
    }),
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
