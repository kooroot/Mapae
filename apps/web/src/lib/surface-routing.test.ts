import {describe, expect, test} from "bun:test";
import {surfaceRedirect} from "./surface-routing";

const SITES = {landingUrl: "https://mapae.io", faucetUrl: "https://faucet.mapae.io"};
const at = (href: string) => new URL(href);
const location = (response: Response | undefined) => response?.headers.get("Location");

describe("surfaceRedirect", () => {
    test("the faucet site serves only its own page and API", () => {
        for (const path of ["/", "/ko", "/ko/", "/api/faucet/status"]) expect(surfaceRedirect("faucet", at(`https://faucet.mapae.io${path}`), SITES)).toBeUndefined();
    });

    test("the arcade and the Studio on the faucet site go to mapae.io, query kept", () => {
        const arcade = surfaceRedirect("faucet", at("https://faucet.mapae.io/ko/arcade/wallet?x=1"), SITES);
        expect(arcade?.status).toBe(308);
        expect(location(arcade)).toBe("https://mapae.io/ko/arcade/wallet?x=1");
        expect(location(surfaceRedirect("faucet", at("https://faucet.mapae.io/app"), SITES))).toBe("https://mapae.io/app");
    });

    test("another site's API on the faucet site is a 404, never a redirect", () => {
        const response = surfaceRedirect("faucet", at("https://faucet.mapae.io/api/arcade/profile/session"), SITES);
        expect(response?.status).toBe(404);
        expect(location(response)).toBeNull();
    });

    test("/faucet on the faucet site is its root", () => {
        expect(location(surfaceRedirect("faucet", at("https://faucet.mapae.io/ko/faucet"), SITES))).toBe("https://faucet.mapae.io/ko");
        expect(location(surfaceRedirect("faucet", at("https://faucet.mapae.io/faucet/"), SITES))).toBe("https://faucet.mapae.io/");
    });

    test("/faucet on mapae.io and app.mapae.io goes to faucet.mapae.io in the same language", () => {
        expect(location(surfaceRedirect("landing", at("https://mapae.io/faucet"), SITES))).toBe("https://faucet.mapae.io/");
        expect(location(surfaceRedirect("app", at("https://app.mapae.io/ko/faucet"), SITES))).toBe("https://faucet.mapae.io/ko");
        expect(surfaceRedirect("landing", at("https://mapae.io/ko/arcade"), SITES)).toBeUndefined();
    });

    test("a combined dev server serves every page", () => {
        for (const path of ["/faucet", "/ko/arcade", "/app"]) expect(surfaceRedirect("combined", at(`http://127.0.0.1:5173${path}`), SITES)).toBeUndefined();
    });
});
