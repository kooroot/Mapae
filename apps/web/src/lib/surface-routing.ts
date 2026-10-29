import type {SiteSurface} from "./config";
import {localizeUrl} from "./i18n";

/**
 * Which site answers which page, once production splits the one bundle into three.
 *
 * Every route exists in every build, so without this faucet.mapae.io would also render
 * the arcade and the Studio — on the one origin whose policy admits Turnstile's script,
 * beside the arcade's bearer payments in sessionStorage and the Studio's agent key — and
 * mapae.io/faucet would render a faucet whose API refuses every origin but its own.
 * Each such address is sent to the site that owns it. A combined (dev) server serves
 * everything, so it is never redirected. The faucet also answers the engagement API, so
 * its own page arrivals and claims are counted under its own browser IDs.
 */
const FAUCET_DOCUMENT = /^(\/ko)?\/?$/;
const FAUCET_ALIAS = /^(\/ko)?\/faucet\/?$/;

export function surfaceRedirect(surface: SiteSurface, url: URL, sites: {landingUrl: string; faucetUrl: string}): Response | undefined {
    const path = url.pathname;
    if (surface === "combined") return undefined;
    const alias = FAUCET_ALIAS.exec(path);
    if (surface !== "faucet") {
        return alias ? Response.redirect(localizeUrl(sites.faucetUrl, alias[1] ? "ko" : "en"), 308) : undefined;
    }
    if (FAUCET_DOCUMENT.test(path) || path.startsWith("/api/faucet/") || path === "/api/arcade/engagement") return undefined;
    if (alias) return Response.redirect(new URL(alias[1] ? "/ko" : "/", url.origin).href, 308);
    // An API this site does not serve is absent, not elsewhere: a redirected POST would only fail later.
    if (path.startsWith("/api/")) return new Response(null, {status: 404, headers: {"Cache-Control": "no-store"}});
    return Response.redirect(new URL(`${path}${url.search}`, sites.landingUrl).href, 308);
}
