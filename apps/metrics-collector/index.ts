/**
 * apps/metrics-collector — run by launchd on the Mac mini.
 *
 *   bun run index.ts hourly   ledger invariants + funded-wallet balances → /ingest
 *   bun run index.ts daily    index the chain, compute the snapshot     → /ingest (+ file)
 *
 * It knows nothing about Telegram. The Worker is the only sender, so de-duplication and
 * the heartbeat judgement ("this Mac has gone quiet") live in one place, off this host.
 */
import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import type {Database} from "bun:sqlite";
import {throttledHttp} from "@mapae/delegation";
import {giwaSepolia} from "@mapae/shared/chain";
import {redactForLog} from "@mapae/shared/errors";
import type {DailySnapshot, IngestItem} from "@mapae/shared/ops-ingest";
import {createPublicClient, formatEther, type Address} from "viem";
import {buildClassifier, loadCohort, loadDeployment, type Deployment} from "./addresses";
import {parseConfig, type Config} from "./config";
import {indexChain, openMetricsDb, readChainEvents, type ChainSource} from "./indexer";
import {postIngest, type Fetch} from "./ingest";
import {internalPayees, LEDGER_ITEMS, ledgerDaily, ledgerInvariants} from "./ledger";
import {computeChainMetrics, computeRetention, DAY_MS, kstDay, kstDayStart} from "./metrics";
import {viemChainSource} from "./viem-source";

export async function hourlyItems(config: Config, now: number, balance: (address: Address) => Promise<bigint>): Promise<IngestItem[]> {
    const items: IngestItem[] = [];
    try {
        items.push(...await ledgerInvariants({seller: config.sellerStore, facilitator: config.facilitatorStore}, now, config.relayerDailyWei));
        items.push({name: "ledger-readable", ok: true});
    } catch (error) {
        console.error(`ledger read failed: ${redactForLog(error)}`);
        items.push(...LEDGER_ITEMS.map(name => ({name, ok: false, detail: "not measured: ledger unreadable"})));
        items.push({name: "ledger-readable", ok: false, detail: "facilitator or seller store unreadable"});
    }
    for (const wallet of config.wallets) {
        const name = `wallet-${wallet.role}`;
        try {
            const wei = await balance(wallet.address);
            items.push({name, ok: wei >= config.walletMinWei, detail: `${formatEther(wei)} ETH`});
        } catch (error) {
            console.error(`${name} balance read failed: ${redactForLog(error)}`);
            items.push({name, ok: false, detail: "balance unreadable"});
        }
    }
    return items;
}

export async function dailySnapshot(config: Config, deployment: Deployment, db: Database, source: ChainSource, now: number): Promise<DailySnapshot> {
    const indexed = await indexChain(db, source, async () => (await source.receipt(deployment.firstTransaction)).blockNumber, config.logSpan);
    const cohort = loadCohort(config.cohortFile);
    const classifier = buildClassifier([
        ...deployment.internal,
        ...config.wallets.map(w => w.address),
        ...config.extraInternal,
        ...internalPayees(config.sellerStore),
    ], cohort.addresses);

    // The day that just closed in Korea. A run at 00:30 KST measures the whole of yesterday.
    const day = kstDay(now - DAY_MS);
    const startMs = kstDayStart(day);
    const endMs = startMs + DAY_MS;
    // The finalized head trails latest by ~20 minutes, and a stalled batcher or a run right
    // after wake can leave it short of midnight. A snapshot cut there would undercount the
    // day's last stretch with nothing marking it, and the Worker keeps one snapshot per day,
    // so no later run would correct it. Failing instead silences the daily heartbeat, which
    // the Worker reports; a re-run the same morning overwrites the day.
    const headMs = Number(indexed.head.timestamp) * 1000;
    if (headMs < endMs) {
        throw new Error(`finalized head ${indexed.head.number} at ${new Date(headMs).toISOString()} does not reach the end of ${day} KST (${new Date(endMs).toISOString()}); re-run later`);
    }
    const events = readChainEvents(db, config.signer);
    const roles = {signer: config.signer, sponsor: config.sponsor};
    return {
        version: 1,
        day,
        generatedAt: new Date(now).toISOString(),
        chain: {
            fromBlock: Number(indexed.fromBlock),
            toBlock: Number(indexed.head.number),
            blockHash: indexed.head.hash,
            toBlockTime: new Date(headMs).toISOString(),
        },
        classification: {internal: classifier.internal.size, cohort: classifier.cohort.size, cohortSource: cohort.source},
        day_metrics: computeChainMetrics(events, {startMs, endMs}, classifier, roles),
        week_metrics: computeChainMetrics(events, {startMs: endMs - 7 * DAY_MS, endMs}, classifier, roles),
        all_time: computeChainMetrics(events, {startMs: 0, endMs}, classifier, roles),
        retention: computeRetention(events, endMs, classifier),
        ledger: ledgerDaily(config.facilitatorStore, {startMs, endMs}),
        week_ledger: ledgerDaily(config.facilitatorStore, {startMs: endMs - 7 * DAY_MS, endMs}),
    };
}

async function main(mode: string | undefined): Promise<void> {
    if (mode !== "hourly" && mode !== "daily") throw new Error("usage: bun run index.ts hourly|daily");
    const config = parseConfig(process.env);
    const send = (payload: Parameters<typeof postIngest>[3]) => postIngest(fetch as Fetch, config.ingestUrl, config.ingestToken, payload);

    if (mode === "hourly") {
        // Balances come from the public endpoint: an hourly read needs no private quota.
        const client = createPublicClient({chain: giwaSepolia, transport: throttledHttp(giwaSepolia.rpcUrls.default.http[0])});
        await send({kind: "hourly", items: await hourlyItems(config, Date.now(), address => client.getBalance({address}))});
        return;
    }

    const deployment = loadDeployment();
    const client = createPublicClient({chain: giwaSepolia, transport: throttledHttp(config.rpcUrl)});
    const source = viemChainSource(client, {delegationManager: deployment.delegationManager, simpleFactory: deployment.simpleFactory});
    const db = openMetricsDb(config.metricsDb);
    let snapshot: DailySnapshot;
    try {
        snapshot = await dailySnapshot(config, deployment, db, source, Date.now());
    } finally {
        db.close();
    }
    // The file is written before the POST so a Worker outage does not lose the day.
    if (config.snapshotDir) {
        mkdirSync(config.snapshotDir, {recursive: true});
        writeFileSync(join(config.snapshotDir, `${snapshot.day}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    await send({kind: "daily", day: snapshot.day, snapshot});
}

if (import.meta.main) {
    const mode = process.argv[2];
    try {
        await main(mode);
    } catch (error) {
        console.error(`metrics-collector ${mode ?? ""} failed: ${redactForLog(error)}`);
        process.exitCode = 1;
    }
}
