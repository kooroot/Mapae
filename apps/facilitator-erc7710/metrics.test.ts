import {describe, expect, test} from "bun:test";
import {openStore} from "@mapae/store";
import {bearerTokenMatches, metricsReport, readMetricsToken, summaryJson} from "./metrics.js";

const TOKEN = "correct-horse-battery-staple";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const SHOP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DAY_MS = 86_400_000;

describe("readMetricsToken", () => {
    test("unset or blank disables the endpoint; whitespace is trimmed", () => {
        expect(readMetricsToken(undefined)).toBeUndefined();
        expect(readMetricsToken("")).toBeUndefined();
        expect(readMetricsToken("   \n")).toBeUndefined();
        expect(readMetricsToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    });

    test("refuses a token shorter than 16 characters", () => {
        expect(() => readMetricsToken("short")).toThrow(/at least 16/);
        expect(readMetricsToken("0123456789abcdef")).toBe("0123456789abcdef");
    });
});

describe("bearerTokenMatches", () => {
    test("accepts only the configured token behind a Bearer scheme", () => {
        expect(bearerTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
        expect(bearerTokenMatches(`bearer   ${TOKEN}  `, TOKEN)).toBe(true);
        expect(bearerTokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
        expect(bearerTokenMatches(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
        expect(bearerTokenMatches("Bearer nope", TOKEN)).toBe(false);
    });

    test("refuses a missing, empty or non-Bearer header without throwing", () => {
        expect(bearerTokenMatches(undefined, TOKEN)).toBe(false);
        expect(bearerTokenMatches("", TOKEN)).toBe(false);
        expect(bearerTokenMatches("Bearer", TOKEN)).toBe(false);
        expect(bearerTokenMatches("Bearer ", TOKEN)).toBe(false);
        expect(bearerTokenMatches(TOKEN, TOKEN)).toBe(false);
        expect(bearerTokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
        expect(bearerTokenMatches(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
    });
});

describe("summaryJson", () => {
    test("renders every bigint as a decimal string, exactly", () => {
        expect(
            summaryJson({
                total: 3,
                succeeded: 2,
                failed: 1,
                volumeByPayTo: {[SHOP]: 2n ** 70n, [BOB]: 0n},
                uniquePayers: 2,
            }),
        ).toEqual({
            total: 3,
            succeeded: 2,
            failed: 1,
            volumeByPayTo: {[SHOP]: "1180591620717411303424", [BOB]: "0"},
            uniquePayers: 2,
        });
    });
});

describe("metricsReport", () => {
    test("splits the ledger into a rolling 24h window and all time, JSON-safe", () => {
        const store = openStore(":memory:");
        try {
            const now = 10 * DAY_MS;
            const base = {kind: "settle", payTo: SHOP, amountBase: 100n} as const;
            store.ledger.record({...base, at: now - 2 * DAY_MS, payer: ALICE, outcome: "settled"});
            store.ledger.record({...base, at: now - DAY_MS + 1, payer: BOB, outcome: "settled"});
            store.ledger.record({...base, at: now, payer: BOB, outcome: "rejected"});

            const report = metricsReport(store.ledger, now);
            expect(report).toEqual({
                last24h: {
                    total: 2,
                    succeeded: 1,
                    failed: 1,
                    volumeByPayTo: {[SHOP]: "100"},
                    uniquePayers: 1,
                },
                allTime: {
                    total: 3,
                    succeeded: 2,
                    failed: 1,
                    volumeByPayTo: {[SHOP]: "200"},
                    uniquePayers: 2,
                },
            });
            expect(() => JSON.stringify(report)).not.toThrow();
            // A clock earlier than one day after the epoch clamps the window to the epoch
            // instead of handing the store a negative `sinceMs`.
            expect(() => metricsReport(store.ledger, 0)).not.toThrow();
            expect(metricsReport(store.ledger, 0).last24h).toEqual(report.allTime);
        } finally {
            store.close();
        }
    });
});
