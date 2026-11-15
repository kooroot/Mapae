import {afterEach, beforeEach, expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ROOT_AUTHORITY} from "@mapae/delegation/delegation-status";
import {SCHEMA_SQL} from "@mapae/store/schema";
import {parseIngest} from "@mapae/shared/ops-ingest";
import {getAddress, keccak256, toHex, type Address} from "viem";
import {loadCohort, loadDeployment} from "./addresses";
import {parseConfig} from "./config";
import {dailySnapshot, hourlyItems} from "./index";
import {openMetricsDb, type ChainSource} from "./indexer";
import {postIngest, type Fetch} from "./ingest";
import {LEDGER_ITEMS} from "./ledger";

const TOKEN = "t".repeat(40);
const SIGNER = "0x5eA109EDC7E89b6A752032Aa2B6F1092e081E7eC";
let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "metrics-collector-"));
    for (const name of ["seller.sqlite", "facilitator.sqlite"]) {
        const db = new Database(join(dir, name), {create: true});
        db.exec(SCHEMA_SQL);
        db.close();
    }
});
afterEach(() => rmSync(dir, {recursive: true, force: true}));

const env = (over: Record<string, string> = {}) => ({
    OPS_INGEST_URL: "https://mapae-ops-monitor.example.workers.dev/ingest",
    INGEST_TOKEN: TOKEN,
    SELLER_STORE_PATH: join(dir, "seller.sqlite"),
    FACILITATOR_STORE_PATH: join(dir, "facilitator.sqlite"),
    METRICS_DB_PATH: ":memory:",
    FACILITATOR_SIGNER_ADDRESS: SIGNER,
    ...over,
});

test("config refuses a cleartext ingest URL and a weak token without echoing it", () => {
    expect(parseConfig(env()).ingestUrl).toBe("https://mapae-ops-monitor.example.workers.dev/ingest");
    expect(parseConfig(env({OPS_INGEST_URL: "http://127.0.0.1:8787/ingest"})).ingestUrl).toBe("http://127.0.0.1:8787/ingest");
    expect(() => parseConfig(env({OPS_INGEST_URL: "http://ops.example/ingest"}))).toThrow("OPS_INGEST_URL");
    expect(() => parseConfig(env({OPS_INGEST_URL: "https://ops.example/other"}))).toThrow("OPS_INGEST_URL");
    try {
        parseConfig(env({INGEST_TOKEN: "short-secret-value"}));
        throw new Error("accepted");
    } catch (error) {
        expect(String(error)).toContain("INGEST_TOKEN");
        expect(String(error)).not.toContain("short-secret-value");
    }
    expect(() => parseConfig(env({FACILITATOR_SIGNER_ADDRESS: "0x1234"}))).toThrow("FACILITATOR_SIGNER_ADDRESS");
    expect(() => parseConfig(env({METRICS_INTERNAL_ADDRESSES: `${SIGNER},nope`}))).toThrow("METRICS_INTERNAL_ADDRESSES[1]");
    // The default must stay within the public endpoint's eth_getLogs limit, or the daily run dies on its first call.
    expect(parseConfig(env()).logSpan).toBe(10_000n);
    expect(parseConfig(env({METRICS_LOG_SPAN: "1000"})).logSpan).toBe(1000n);
    expect(() => parseConfig(env({METRICS_LOG_SPAN: "0"}))).toThrow("METRICS_LOG_SPAN");
});

test("postIngest sends the bearer, refuses redirects, and checks the payload against the Worker's parser first", async () => {
    const sent: RequestInit[] = [];
    const ok: Fetch = async (_url, init) => (sent.push(init), new Response("{}", {status: 200}));
    await postIngest(ok, "https://ops.example/ingest", TOKEN, {kind: "hourly", items: [{name: "pending-intents", ok: true}]});
    expect(new Headers(sent[0]!.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]!.redirect).toBe("error");

    await expect(postIngest(ok, "https://ops.example/ingest", TOKEN, {kind: "hourly", items: [{name: "Bad Name", ok: true}]})).rejects.toThrow("ingest_payload_invalid");
    expect(sent.length).toBe(1);
    await expect(postIngest(async () => new Response("", {status: 401}), "https://ops.example/ingest", TOKEN, {kind: "hourly", items: []})).rejects.toThrow("HTTP 401");
});

test("hourly items: an unreadable ledger and an unreadable balance are failures, never omissions", async () => {
    const config = parseConfig(env({BOOTSTRAP_ADDRESS: `0x${"5".repeat(40)}`, WALLET_MIN_WEI: "100"}));
    const items = await hourlyItems(config, Date.parse("2026-10-12T12:00:00Z"), async (address: Address) => {
        if (address === config.sponsor) throw new Error("rpc down at https://rpc.example/secret-key");
        return 99n;
    });
    const byName = Object.fromEntries(items.map(i => [i.name, i]));
    expect(byName["ledger-readable"]!.ok).toBe(true);
    expect(byName["wallet-facilitator-signer"]).toEqual({name: "wallet-facilitator-signer", ok: false, detail: "0.000000000000000099 ETH"});
    expect(byName["wallet-bootstrap-sponsor"]).toEqual({name: "wallet-bootstrap-sponsor", ok: false, detail: "balance unreadable"});
    expect(parseIngest({kind: "hourly", items})).not.toBeNull();

    const broken = await hourlyItems(parseConfig(env({BOOTSTRAP_ADDRESS: `0x${"5".repeat(40)}`, FACILITATOR_STORE_PATH: join(dir, "absent.sqlite")})), Date.now(), async () => 10n ** 18n);
    expect(broken.find(i => i.name === "ledger-readable")).toEqual({name: "ledger-readable", ok: false, detail: "facilitator or seller store unreadable"});
    // The same names every hour, readable or not: the Worker clears a failing item that goes missing.
    expect(broken.map(i => i.name).sort()).toEqual(items.map(i => i.name).sort());
    for (const name of LEDGER_ITEMS) expect(broken.find(i => i.name === name)).toEqual({name, ok: false, detail: "not measured: ledger unreadable"});
    expect(parseIngest({kind: "hourly", items: broken})).not.toBeNull();
});

test("cohort file: absent is reported as missing; malformed is refused", () => {
    expect(loadCohort(undefined)).toEqual({addresses: [], source: "missing"});
    expect(loadCohort(join(dir, "nope.json"))).toEqual({addresses: [], source: "missing"});
    const file = join(dir, "cohort.json");
    writeFileSync(file, JSON.stringify([`0x${"a".repeat(40)}`]));
    expect(loadCohort(file)).toEqual({addresses: [getAddress(`0x${"a".repeat(40)}`)], source: "file"});
    writeFileSync(file, JSON.stringify({addresses: []}));
    expect(() => loadCohort(file)).toThrow("JSON array");
});

const settledAt = BigInt(Math.floor(Date.parse("2026-10-12T03:00:00Z") / 1000));
// 2026-10-12 KST ends at 2026-10-12T15:00:00Z.
const dayEnd = BigInt(Date.parse("2026-10-12T15:00:00Z") / 1000);

/** One settlement by the signer and, when `selfRedeemed` is set, one redemption the same payer's owner sent itself. */
function fakeSource(headTimestamp: bigint, selfRedeemed = false): ChainSource {
    const payer = getAddress(`0x${"1".repeat(40)}`);
    const owner = getAddress(`0x${"9".repeat(40)}`);
    const ownTx = keccak256(toHex("own"));
    return {
        finalizedHead: async () => ({number: 1_000n, hash: keccak256(toHex("head")), timestamp: headTimestamp}),
        blockTimestamp: async () => settledAt,
        receipt: async hash => ({from: hash === ownTx ? owner : getAddress(SIGNER), blockNumber: 900n, logs: []}),
        redeemed: async (from, to) => from <= 950n && 950n <= to
            ? [
                {transactionHash: keccak256(toHex("s")), logIndex: 0, blockNumber: 950n, rootDelegator: payer, redeemer: getAddress(SIGNER), authority: ROOT_AUTHORITY},
                ...(selfRedeemed ? [{transactionHash: ownTx, logIndex: 0, blockNumber: 951n, rootDelegator: payer, redeemer: owner, authority: ROOT_AUTHORITY}] : []),
            ]
            : [],
        disabled: async () => [],
        deployed: async () => [],
    };
}

test("the daily snapshot from real deployment artifacts is one the Worker accepts", async () => {
    const deployment = loadDeployment();
    expect(deployment.internal.length).toBeGreaterThan(5);
    const db = openMetricsDb(":memory:");
    const snapshot = await dailySnapshot(parseConfig(env()), deployment, db, fakeSource(dayEnd + 60n), Date.parse("2026-10-13T00:30:00Z"));
    expect(snapshot.day).toBe("2026-10-12");
    expect(snapshot.chain).toMatchObject({fromBlock: 900, toBlock: 1000});
    expect(snapshot.classification.cohortSource).toBe("missing");
    expect(snapshot.day_metrics.settlements).toEqual({internal: 0, cohort: 0, organic: 1});
    expect(snapshot.ledger.broadcastSuccessRate).toBeNull();
    expect(parseIngest(JSON.parse(JSON.stringify({kind: "daily", day: snapshot.day, snapshot})))).not.toBeNull();
});

test("a known payer's redemption the signer did not send reaches the snapshot as a gas violation, not as a settlement", async () => {
    const run = (selfRedeemed: boolean) => dailySnapshot(parseConfig(env()), loadDeployment(), openMetricsDb(":memory:"), fakeSource(dayEnd + 60n, selfRedeemed), Date.parse("2026-10-13T00:30:00Z"));
    const [relayed, mixed] = [await run(false), await run(true)];
    expect(relayed.day_metrics.payerGasViolations).toEqual({internal: 0, cohort: 0, organic: 0});
    expect(mixed.day_metrics.payerGasViolations).toEqual({internal: 0, cohort: 0, organic: 1});
    expect(mixed.all_time.payerGasViolations.organic).toBe(1);
    const violations = {payerGasViolations: relayed.day_metrics.payerGasViolations};
    expect({...mixed.day_metrics, ...violations}).toEqual(relayed.day_metrics);
    expect({...mixed.all_time, ...violations}).toEqual(relayed.all_time);
    expect(mixed.retention).toEqual(relayed.retention);
});

test("the daily snapshot refuses a finalized head short of the day's end instead of undercounting it", async () => {
    const run = (head: bigint) => dailySnapshot(parseConfig(env()), loadDeployment(), openMetricsDb(":memory:"), fakeSource(head), Date.parse("2026-10-13T00:30:00Z"));
    await expect(run(dayEnd - 1n)).rejects.toThrow("does not reach the end of 2026-10-12 KST");
    expect((await run(dayEnd)).chain.toBlockTime).toBe("2026-10-12T15:00:00.000Z");
});
