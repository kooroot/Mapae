/**
 * DAP report (ENG-3): Daily Activated Payers per Korean day, from an exported facilitator database.
 * Read-only; the counting and the farm-exclusion rules are countDailyActivatedPayers (ENG-2,
 * packages/shared/src/metrics/dap.ts) and are not repeated here.
 *
 * Settled payments: settlement_intents joined to its terminal settlement_events row with
 * outcome = 'settled' (the same join scripts/ops/reconcile.ts makes). The event's `at` (ms) is the
 * settlement time. Kind is "arcade" when pay_to equals ARCADE_PAY_TO, otherwise "agent".
 *
 * Payer → owner EOA. `payer` is the delegator HybridDeleGator smart account. Its owner EOA is:
 *   --funding FILE  the `owners` map in the file ({"<payer>": "<owner>"}), written by the Operator;
 *   --chain         `owner()` read from the payer contract on GIWA Sepolia (HybridDeleGator is
 *                   Ownable; a payer with no code or a failing call has no owner);
 *   neither         no mapping.
 * The zero address is never an owner: a HybridDeleGator whose ownership was renounced reports it,
 * and treating it as an owner would merge unrelated accounts into one person.
 * A payer whose owner cannot be resolved stays its own owner and is listed in `payers` with
 * ownerResolved:false, so a person with several smart accounts may count more than once there.
 *
 * Owner funding (first funder, first transaction time) feeds the shared-funder and same-day-cluster
 * rules. --funding reads it from the file's `funding` array; --chain reads each owner's oldest
 * transactions from the GIWA Sepolia explorer (Blockscout txlist, ascending): the first funder is
 * the sender of the oldest successful incoming transaction with value (reverted ones, isError "1"
 * or txreceipt_status "0", moved nothing and are skipped), the first-tx time is the oldest
 * transaction either way. Internal transfers are not seen; an owner with no such transaction has
 * no funding fact and is judged by the operator list only. Pass the faucet with --public-funders
 * (or `publicFunders` in the file), otherwise everyone it funded reads as one shared funder.
 *
 * Funding file shape: {"owners": {...}, "funding": [{"owner","firstFunder","firstTxAt"(unix s)}],
 * "publicFunders": ["0x.."]}; a bare funding array is accepted too.
 *
 * Live run (Operator, repository root, on a machine holding the exports; sessions cannot reach it):
 *   1. Snapshot the serving databases with scripts/ops/backup.ts and restore a plain copy:
 *        bun scripts/ops/backup.ts backup /absolute/facilitator.sqlite /backup/fac.enc /private/key
 *        bun scripts/ops/backup.ts restore /backup/fac.enc /tmp/facilitator-export.sqlite /private/key
 *      (same for the seller database → /tmp/seller-export.sqlite, optional)
 *   2. bun scripts/dap-report.ts /tmp/facilitator-export.sqlite --seller /tmp/seller-export.sqlite \
 *        --chain --public-funders 0xFAUCET --operators 0xOPERATOR1,0xOPERATOR2 --from 2026-10-01
 * Prints JSON; exit 0 on success, 1 on unusable input. No database is written.
 */
import {Database} from "bun:sqlite";
import {readFileSync} from "node:fs";
import {parseArgs} from "node:util";
import {createPublicClient, isAddress, type Address} from "viem";
import {giwaSepolia} from "../packages/shared/src/chain";
import {countDailyActivatedPayers, type DapDay, type OwnerFunding, type SettledPayment} from "../packages/shared/src/metrics/dap";
import {throttledHttp} from "../packages/delegation/src/index";
import {ARCADE_PAY_TO} from "../packages/arcade/src/tickets";

export type ChainClient = {
    /** Owner EOA of a delegator smart account, or null when it cannot be read. */
    ownerOf(account: Address): Promise<Address | null>;
    /** First funder and first transaction time (unix seconds) of an owner, or null. */
    firstFunding(owner: Address): Promise<{firstFunder: Address; firstTxAt: number} | null>;
};
export type FundingFile = {owners?: Record<string, string>; funding?: OwnerFunding[]; publicFunders?: string[]};
export type DapReportInput = {
    facilitator: Database;
    seller?: Database;
    funding?: FundingFile;
    chain?: ChainClient;
    operators?: string[];
    publicFunders?: string[];
    from?: string;
    to?: string;
};
export type PayerOwner = {payer: string; owner: string; ownerResolved: boolean};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const fail = (code: string) => new Error(code);
const norm = (a: string) => a.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
/** A usable owner: a well-formed address other than zero (a renounced HybridDeleGator reports zero). */
const ownerAddress = (a: string | null) => (a && isAddress(a, {strict: false}) && norm(a) !== ZERO ? norm(a) : null);
const addresses = (list: readonly string[] | undefined, code: string) =>
    (list ?? []).map((a) => {
        if (!isAddress(a, {strict: false})) throw fail(code);
        return norm(a);
    });

type Row = {payer: string; pay_to: string; chain_id: number; tx_hash: string; at: number};

export async function dapReport(input: DapReportInput) {
    if ((input.from && !DAY.test(input.from)) || (input.to && !DAY.test(input.to))) throw fail("invalid_day");
    const rows = input.facilitator
        .query<Row, []>(
            `SELECT i.payer, i.pay_to, i.chain_id, i.tx_hash, e.at FROM settlement_intents i
             JOIN settlement_events e ON e.id = i.terminal_event_id WHERE e.outcome = 'settled'`,
        )
        .all();
    const arcade = norm(ARCADE_PAY_TO);

    const owners = new Map<string, PayerOwner>();
    const mapped = new Map(Object.entries(input.funding?.owners ?? {}).map(([p, o]) => [norm(p), norm(o)]));
    for (const payer of new Set(rows.map((r) => norm(r.payer)))) {
        let owner = mapped.get(payer) ?? null;
        if (!owner && input.chain) owner = (await input.chain.ownerOf(payer as Address).catch(() => null))?.toLowerCase() ?? null;
        owner = ownerAddress(owner);
        owners.set(payer, owner ? {payer, owner, ownerResolved: true} : {payer, owner: payer, ownerResolved: false});
    }

    const funding: OwnerFunding[] = [...(input.funding?.funding ?? [])];
    if (input.chain) {
        const known = new Set(funding.map((f) => norm(f.owner)));
        for (const owner of new Set([...owners.values()].map((o) => o.owner))) {
            if (known.has(owner)) continue;
            const fact = await input.chain.firstFunding(owner as Address).catch(() => null);
            if (fact) funding.push({owner, firstFunder: fact.firstFunder, firstTxAt: fact.firstTxAt});
        }
    }

    const payments: SettledPayment[] = rows.map((r) => ({
        owner: owners.get(norm(r.payer))!.owner,
        settledAt: Math.floor(r.at / 1000),
        chainId: `eip155:${r.chain_id}`,
        kind: norm(r.pay_to) === arcade ? "arcade" : "agent",
    }));
    const days: DapDay[] = countDailyActivatedPayers(payments, funding, {
        operatorAllowList: addresses(input.operators, "invalid_operator"),
        publicFunders: addresses([...(input.publicFunders ?? []), ...(input.funding?.publicFunders ?? [])], "invalid_public_funder"),
    }).filter((d) => (!input.from || d.day >= input.from) && (!input.to || d.day <= input.to));

    let seller = null;
    if (input.seller) {
        const paid = new Set(
            input.seller
                .query<{tx_hash: string | null}, []>("SELECT tx_hash FROM orders WHERE tx_hash IS NOT NULL")
                .all()
                .map((o) => norm(o.tx_hash!)),
        );
        seller = {settledWithoutOrder: rows.filter((r) => !paid.has(norm(r.tx_hash))).length};
    }

    const payers = [...owners.values()].sort((a, b) => (a.payer < b.payer ? -1 : 1));
    return {
        timezone: "Asia/Seoul",
        chainId: `eip155:${giwaSepolia.id}`,
        window: {from: input.from ?? null, to: input.to ?? null},
        settledPayments: rows.length,
        ownerSource: input.funding?.owners ? "funding-file" : input.chain ? "chain" : "none",
        unresolvedOwners: payers.filter((p) => !p.ownerResolved).length,
        fundingFacts: funding.length,
        seller,
        rows: days.map(({day, raw, excluded, dap, arcadeDap, agentDap, excludedPayers}) => ({day, raw, excluded, dap, arcadeDap, agentDap, excludedPayers})),
        payers,
    };
}

const ownerAbi = [{type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{type: "address"}]}] as const;

/** Live GIWA Sepolia client: owner() over RPC, oldest transactions from the Blockscout explorer. */
export function liveChainClient(fetcher: typeof fetch = fetch): ChainClient {
    const rpc = createPublicClient({chain: giwaSepolia, transport: throttledHttp(giwaSepolia.rpcUrls.default.http[0], {}, {timeout: 15_000, retryCount: 0})});
    const explorer = giwaSepolia.blockExplorers.default.url;
    return {
        async ownerOf(account) {
            if (!(await rpc.getCode({address: account}))) return null;
            return rpc.readContract({address: account, abi: ownerAbi, functionName: "owner"});
        },
        async firstFunding(owner) {
            const url = `${explorer}/api?module=account&action=txlist&address=${owner}&sort=asc&page=1&offset=50`;
            const body = (await (await fetcher(url, {signal: AbortSignal.timeout(15_000)})).json()) as {
                result?: {from: string; to: string; value: string; timeStamp: string; isError?: string; txreceipt_status?: string}[];
            };
            const txs = Array.isArray(body.result) ? body.result : [];
            const first = txs[0];
            // A reverted transfer moved no value, so it funds nobody.
            const succeeded = (t: (typeof txs)[number]) => t.isError !== "1" && t.txreceipt_status !== "0";
            const funded = txs.find((t) => succeeded(t) && norm(t.to ?? "") === norm(owner) && t.value !== "0" && isAddress(t.from, {strict: false}));
            if (!first || !funded) return null;
            return {firstFunder: funded.from as Address, firstTxAt: Number(first.timeStamp)};
        },
    };
}

/** Reads a funding file: the object shape above, or a bare OwnerFunding array. */
export function loadFundingFile(path: string): FundingFile {
    const value = JSON.parse(readFileSync(path, "utf8")) as FundingFile | OwnerFunding[];
    const file = Array.isArray(value) ? {funding: value} : value;
    for (const f of file.funding ?? []) {
        if (!isAddress(f.owner, {strict: false}) || !isAddress(f.firstFunder, {strict: false}) || !Number.isSafeInteger(f.firstTxAt)) throw fail("invalid_funding_file");
    }
    return file;
}

export function parseDapArgs(argv: string[]) {
    const {values, positionals} = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: true,
        options: {
            seller: {type: "string"},
            funding: {type: "string"},
            chain: {type: "boolean"},
            operators: {type: "string"},
            "public-funders": {type: "string"},
            from: {type: "string"},
            to: {type: "string"},
        },
    });
    if (positionals.length !== 1) throw fail("facilitator_db_required");
    if (values.funding && values.chain) throw fail("funding_or_chain");
    const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
    return {
        facilitatorDb: positionals[0]!,
        sellerDb: values.seller,
        fundingFile: values.funding,
        chain: values.chain ?? false,
        operators: list(values.operators),
        publicFunders: list(values["public-funders"]),
        from: values.from,
        to: values.to,
    };
}

if (import.meta.main) {
    try {
        const args = parseDapArgs(process.argv.slice(2));
        const facilitator = new Database(args.facilitatorDb, {readonly: true});
        const seller = args.sellerDb ? new Database(args.sellerDb, {readonly: true}) : undefined;
        try {
            const report = await dapReport({
                facilitator,
                seller,
                funding: args.fundingFile ? loadFundingFile(args.fundingFile) : undefined,
                chain: args.chain ? liveChainClient() : undefined,
                operators: args.operators,
                publicFunders: args.publicFunders,
                from: args.from,
                to: args.to,
            });
            console.log(JSON.stringify(report, null, 2));
        } finally {
            facilitator.close();
            seller?.close();
        }
    } catch (error) {
        console.error(`DAP report unavailable (${error instanceof Error ? error.message : "error"}). Usage: bun scripts/dap-report.ts FACILITATOR_DB [--seller SELLER_DB] [--funding FUNDING_JSON | --chain] [--operators 0x..,0x..] [--public-funders 0x..] [--from YYYY-MM-DD] [--to YYYY-MM-DD]`);
        process.exitCode = 1;
    }
}
