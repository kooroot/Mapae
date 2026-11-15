import {expect, test} from "bun:test";
import {TELEGRAM_MESSAGE_LIMIT, sendTelegram} from "./telegram";
import {addDays, dailyReport, escapeHtml, weekEnding, weeklyReport} from "./report";
import {snapshotFixture} from "./snapshot-fixture";

test("HTML escaping covers the three characters Telegram parses", () => {
    expect(escapeHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
});

test("day arithmetic and the week a snapshot day closes", () => {
    expect(weekEnding("2026-10-11")).toBe("2026-10-11"); // a Sunday closes its own week
    expect(weekEnding("2026-10-12")).toBe("2026-10-11");
    expect(weekEnding("2026-10-17")).toBe("2026-10-11"); // Saturday: this week is still open
    expect(weekEnding("2026-03-02")).toBe("2026-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-11", -7)).toBe("2026-10-04");
});

test("the daily report carries the eight headlines with signed deltas", () => {
    const previous = snapshotFixture("2026-10-11");
    const current = snapshotFixture("2026-10-12", s => {
        s.day_metrics.settlements = {internal: 2, cohort: 0, organic: 4};
        s.ledger = {...s.ledger, settled: 9, error: 1};
        s.day_metrics.payeeTop1 = {part: {internal: 2, cohort: 0, organic: 1}, whole: {internal: 2, cohort: 0, organic: 4}};
    });
    const text = dailyReport(current, previous);
    expect(text).toStartWith("<b>Mapae daily · 2026-10-12 KST</b>\nvs 2026-10-11");
    for (let i = 1; i <= 8; i++) expect(text).toContain(`<b>${i}. `);
    expect(text).toContain("int 2 (±0) · coh 0 (-1) · org 4 (+1)");
    expect(text).toContain("9/10 90% (-10pp) settled/(settled+error)");
    // 0/0 is "no data", never a percentage and never a delta.
    expect(text).toContain("coh 0/0 · org 1/4 25% (-41.7pp)");
    expect(text).toContain("8. Limit rejections</b>\n  not collected");
    expect(text).not.toContain("VIOLATION");
});

test("without a previous day there are no deltas; violations and a missing cohort file are flagged", () => {
    const text = dailyReport(snapshotFixture("2026-10-12", s => {
        s.day_metrics.payerGasViolations.organic = 1;
        s.classification.cohortSource = "missing";
        s.ledger = {...s.ledger, settled: 0, error: 0};
    }), null);
    expect(text).toContain("no snapshot for 2026-10-11; no deltas");
    expect(text).not.toMatch(/\((?:[+-]|±)\d/);
    expect(text).toContain("7. Payments not relayed by Mapae (target 0) — VIOLATION");
    expect(text).toContain("cohort file MISSING");
    expect(text).toContain("no broadcasts");
});

test("the weekly report compares to the week before and shows retention as retained/eligible", () => {
    const text = weeklyReport(snapshotFixture("2026-10-11"), snapshotFixture("2026-10-04", s => {s.retention.w1.part.cohort = 1;}));
    expect(text).toStartWith("<b>Mapae weekly · 2026-10-05 – 2026-10-11 KST</b>\nvs week ending 2026-10-04");
    expect(text).toContain("<b>Retention W1 (retained/eligible)</b>\n  int 0/1 0% (±0pp) · coh 2/4 50% (+25pp) · org 1/3 33.3% (±0pp)");
    expect(text).toContain("<b>Settlement latency</b>\n  p50 2100ms · p95 4800ms · n 6");
    expect(text).toContain("Payer×payee pairs");
});

test("worst-case reports stay under Telegram's limit, and reason keys are escaped", () => {
    const big = snapshotFixture("2026-10-11", s => {
        const many = 10 ** 12;
        for (const m of [s.day_metrics, s.week_metrics]) for (const value of Object.values(m)) {
            if ("part" in value) value.part = value.whole = {internal: many, cohort: many, organic: many};
            else Object.assign(value, {internal: many, cohort: many, organic: many});
        }
        s.week_ledger.failureReasons = Object.fromEntries(Array.from({length: 64}, (_, i) => [`rejected:${"x".repeat(60)}${i}`, many]));
        s.week_ledger.failureReasons["a&b"] = 1;
    });
    for (const text of [dailyReport(big, big), weeklyReport(big, big)]) expect(text.length).toBeLessThan(TELEGRAM_MESSAGE_LIMIT);
    expect(weeklyReport(big, null)).toContain("+60 more");
    expect(weeklyReport(snapshotFixture("2026-10-11", s => {s.week_ledger.failureReasons = {"a&b": 1};}), null)).toContain("a&amp;b 1");
});

test("HTML messages are sent with parse_mode and refused, never cut, when oversized", async () => {
    const token = "123456:" + "A".repeat(35);
    const bodies: unknown[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), Response.json({ok: true}));
    expect(await sendTelegram(fetcher, token, "42", "<b>hi</b>", true)).toBe(true);
    expect(bodies[0]).toMatchObject({parse_mode: "HTML", text: "<b>hi</b>"});
    expect(await sendTelegram(fetcher, token, "42", "x".repeat(4097), true)).toBe(false);
    expect(bodies).toHaveLength(1);
});
