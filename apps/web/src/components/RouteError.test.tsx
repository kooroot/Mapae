import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, test} from "bun:test";
import {RouterContextProvider, createRootRoute, createRouter} from "@tanstack/react-router";
import {renderToStaticMarkup} from "react-dom/server";
import type {Locale} from "../lib/i18n";
import {LocaleProvider} from "../lib/locale";
import {RouteError} from "./RouteError";

/** The fallback as the server would send it: a bare router in context, one locale. */
function render(locale: Locale, error: Error): string {
    const router = createRouter({routeTree: createRootRoute()});
    return renderToStaticMarkup(
        <RouterContextProvider router={router}>
            <LocaleProvider initial={locale}>
                <RouteError error={error} reset={() => {}} />
            </LocaleProvider>
        </RouterContextProvider>,
    );
}

describe("RouteError", () => {
    test("the router names it, so TanStack's attribute-styled fallback never renders", () => {
        // TanStack's `ErrorComponent` is inline `style` objects top to bottom; under the
        // nonce-only `style-src` it would render as unstyled text. The source scan in
        // `security.test.ts` cannot see inside node_modules, so the wiring is pinned here.
        const router = readFileSync(join(import.meta.dir, "../router.tsx"), "utf8");

        expect(router).toContain("defaultErrorComponent: RouteError");
    });

    test("renders no style attribute — every rule comes from the stylesheet", () => {
        for (const locale of ["en", "ko"] as const) {
            const html = render(locale, new Error("boom"));

            expect(html).not.toContain(" style=");
            expect(html).toContain('class="route-error"');
            expect(html).toContain('class="wrap"');
        }
    });

    test("speaks the document's language and shows the thrown message", () => {
        const en = render("en", new Error("RPC unreachable"));
        expect(en).toContain("Something went wrong.");
        expect(en).toContain("Try again");
        expect(en).toContain('<code class="route-error-detail">RPC unreachable</code>');

        const ko = render("ko", new Error("RPC unreachable"));
        expect(ko).toContain("문제가 생겼습니다.");
        expect(ko).toContain("다시 시도");
        expect(ko).toContain('<code class="route-error-detail">RPC unreachable</code>');
        expect(ko).not.toContain("Something went wrong.");
    });

    test("the retry is a real button in the landing's button clothes", () => {
        // `type="button"`: the fallback can render inside a form-free document today, but a
        // submit button is what a bare `<button>` is, and the policy already refuses forms.
        const html = render("en", new Error("boom"));

        expect(html).toContain('<button type="button" class="btn">');
    });

    test("an error without a message leaves the detail line out", () => {
        const html = render("en", new Error(""));

        expect(html).not.toContain("route-error-detail");
    });
});
