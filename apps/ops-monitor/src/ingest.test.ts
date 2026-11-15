import {expect, test} from "bun:test";
import {parseConfig, ConfigError} from "./config";
import {parseDailySnapshot, parseIngest} from "@mapae/shared/ops-ingest";
import {snapshotFixture} from "./snapshot-fixture";
import {bearerMatches, secretEquals} from "./secret";
import {parseCommand, sendTelegram} from "./telegram";

test("hourly ingest accepts named pass/fail items only", () => {
    expect(parseIngest({kind: "hourly", items: [{name: "pending-intents", ok: false, detail: "3 older than 5m"}]}))
        .toEqual({kind: "hourly", items: [{name: "pending-intents", ok: false, detail: "3 older than 5m"}]});
    for (const bad of [
        {kind: "hourly", items: [{name: "Bad Name", ok: true}]},
        {kind: "hourly", items: [{name: "a", ok: "yes"}]},
        {kind: "hourly", items: [{name: "a", ok: true, detail: "line\nbreak"}]},
        {kind: "hourly", items: [{name: "a", ok: true, detail: "x".repeat(201)}]},
        {kind: "hourly", items: [{name: "a", ok: true}, {name: "a", ok: false}]},
        {kind: "hourly", items: [{name: "a", ok: true, extra: 1}]},
        {kind: "hourly", items: [], at: 1},
        {kind: "hourly", items: Array.from({length: 65}, (_, i) => ({name: `a${i}`, ok: true}))},
        {kind: "weekly"}, null, [],
    ]) expect(parseIngest(bad)).toBeNull();
});

test("daily ingest requires a real calendar day and a complete snapshot for that day", () => {
    const snapshot = snapshotFixture("2026-10-12");
    expect(parseIngest(JSON.parse(JSON.stringify({kind: "daily", day: "2026-10-12", snapshot})))).toEqual({kind: "daily", day: "2026-10-12", snapshot});
    expect(parseIngest({kind: "daily", day: "2026-02-30", snapshot: snapshotFixture("2026-02-30")})).toBeNull();
    expect(parseIngest({kind: "daily", day: "2026-10-13", snapshot})).toBeNull();
    expect(parseIngest({kind: "daily", day: "2026-10-12", snapshot: {toBlock: 1}})).toBeNull();
    const broken: ((s: Record<string, any>) => void)[] = [
        s => {s.version = 2;},
        s => {s.extra = 1;},
        s => {delete s.retention;},
        s => {s.day_metrics.settlements.organic = -1;},
        s => {s.day_metrics.settlements.organic = 1.5;},
        s => {s.day_metrics.payeeTop1.part.organic = 9;}, // part above whole
        s => {s.ledger.broadcastSuccessRate = 1.2;},
        s => {s.ledger.failureReasons = {"<b>x</b>": 1};},
        s => {s.ledger.latencyMs.p50 = "fast";},
        s => {s.chain.blockHash = "0x12";},
        s => {s.classification.cohortSource = "guess";},
    ];
    for (const mutate of broken) {
        const copy = JSON.parse(JSON.stringify(snapshot));
        mutate(copy);
        expect(parseDailySnapshot(copy)).toBeNull();
    }
    const nulls = JSON.parse(JSON.stringify(snapshot));
    nulls.ledger.broadcastSuccessRate = null;
    nulls.ledger.latencyMs = {n: 0, p50: null, p95: null};
    expect(parseDailySnapshot(nulls)?.ledger.latencyMs).toEqual({n: 0, p50: null, p95: null});
});

test("secrets compare by value regardless of length; bearer syntax is strict", async () => {
    expect(await secretEquals("abc", "abc")).toBe(true);
    expect(await secretEquals("abc", "abcd")).toBe(false);
    expect(await secretEquals("", "abc")).toBe(false);
    expect(await bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(await bearerMatches("bearer abc", "abc")).toBe(false);
    expect(await bearerMatches("Bearer abc extra", "abc")).toBe(false);
    expect(await bearerMatches(null, "abc")).toBe(false);
});

test("bot commands are honoured only from the allowed chat", () => {
    const update = (id: unknown, text: unknown) => ({update_id: 1, message: {chat: {id}, text}});
    expect(parseCommand(update(42, "/status"), "42")).toBe("status");
    expect(parseCommand(update(-1001, "/report@MapaeOpsBot"), "-1001")).toBe("report");
    expect(parseCommand(update(42, "/help please"), "42")).toBe("help");
    expect(parseCommand(update(43, "/status"), "42")).toBeNull();
    expect(parseCommand(update(42, "/statusx"), "42")).toBeNull();
    expect(parseCommand(update(42, "status"), "42")).toBeNull();
    expect(parseCommand({edited_message: {chat: {id: 42}, text: "/status"}}, "42")).toBeNull();
});

test("Telegram send reports a boolean and never throws the URL that holds the token", async () => {
    const token = "123456:" + "A".repeat(35);
    let body: unknown;
    const ok = await sendTelegram(async (url, init) => {expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`); body = JSON.parse(String(init?.body)); return Response.json({ok: true});}, token, "42", "x".repeat(5000));
    expect(ok).toBe(true);
    expect(body).toMatchObject({chat_id: "42"});
    expect((body as {text: string}).text).toHaveLength(4096);
    expect(await sendTelegram(async () => {throw new Error(`fetch failed for https://api.telegram.org/bot${token}`);}, token, "42", "hi")).toBe(false);
    expect(await sendTelegram(async () => Response.json({ok: false}, {status: 400}), token, "42", "hi")).toBe(false);
});

test("config names a bad secret without echoing it", () => {
    const env = {DB: {} as never, TELEGRAM_BOT_TOKEN: "123456:" + "A".repeat(35), TELEGRAM_CHAT_ID: "42", TELEGRAM_WEBHOOK_SECRET: "w".repeat(32), INGEST_TOKEN: "i".repeat(32), SELLER_METRICS_TOKEN: "s".repeat(16), FACILITATOR_METRICS_TOKEN: "f".repeat(16)};
    expect(parseConfig(env).chatId).toBe("42");
    try {
        parseConfig({...env, INGEST_TOKEN: "short-secret-value"});
        throw new Error("unreachable");
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect(String(error)).toContain("INGEST_TOKEN");
        expect(String(error)).not.toContain("short-secret-value");
    }
});
