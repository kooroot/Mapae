/**
 * Environment, validated once. Secrets (the ingest token, a private RPC URL) are named in
 * errors and never echoed: an error message here ends up in launchd's stderr log.
 */
import {giwaSepolia, isLoopbackHost, parseNodeRpcUrl} from "@mapae/shared/chain";
import {INGEST_TOKEN_PATTERN} from "@mapae/shared/ops-ingest";
import {getAddress, isAddress, type Address} from "viem";

type Env = Record<string, string | undefined>;

export interface Wallet {
    /** The alert item name, `wallet-<role>`. */
    role: string;
    address: Address;
}

export interface Config {
    ingestUrl: string;
    ingestToken: string;
    sellerStore: string;
    facilitatorStore: string;
    metricsDb: string;
    cohortFile?: string;
    snapshotDir?: string;
    /** Private when `GIWA_SEPOLIA_RPC_URL` is set — then a credential, path key and all. */
    rpcUrl: string;
    /** Most blocks one `eth_getLogs` call may cover on `rpcUrl`. */
    logSpan: bigint;
    signer: Address;
    sponsor?: Address;
    /** The funded wallets whose balances the hourly run checks. */
    wallets: Wallet[];
    extraInternal: Address[];
    relayerDailyWei: bigint;
    walletMinWei: bigint;
}

const value = (env: Env, name: string) => env[name]?.trim() || undefined;

function required(env: Env, name: string): string {
    const v = value(env, name);
    if (v === undefined) throw new Error(`${name} is required`);
    return v;
}

function optionalAddress(env: Env, name: string): Address | undefined {
    const v = value(env, name);
    if (v === undefined) return undefined;
    if (!isAddress(v)) throw new Error(`${name} must be an EVM address`);
    return getAddress(v);
}

function positive(env: Env, name: string, fallback: bigint): bigint {
    const v = value(env, name);
    if (v === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(v)) throw new Error(`${name} must be a positive integer`);
    return BigInt(v);
}

/** HTTPS, or loopback for a local `wrangler dev`. The bearer must never cross a network in clear. */
function ingestUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("OPS_INGEST_URL must be a URL");
    }
    const loopback = url.protocol === "http:" && isLoopbackHost(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/ingest")) {
        throw new Error("OPS_INGEST_URL must be an https URL ending in /ingest");
    }
    return url.toString();
}

export function parseConfig(env: Env): Config {
    const ingestToken = required(env, "INGEST_TOKEN");
    if (!INGEST_TOKEN_PATTERN.test(ingestToken)) throw new Error("INGEST_TOKEN must be 32-256 printable characters");
    const signer = optionalAddress(env, "FACILITATOR_SIGNER_ADDRESS");
    if (!signer) throw new Error("FACILITATOR_SIGNER_ADDRESS is required");
    const sponsor = optionalAddress(env, "BOOTSTRAP_ADDRESS");
    const wallets: Wallet[] = [{role: "facilitator-signer", address: signer}];
    if (sponsor) wallets.push({role: "bootstrap-sponsor", address: sponsor});
    for (const [name, role] of [["REVOCATION_RELAYER_ADDRESS", "revocation-relayer"], ["REVOCATION_SPONSOR_ADDRESS", "revocation-sponsor"]] as const) {
        const address = optionalAddress(env, name);
        if (address) wallets.push({role, address});
    }
    const extra = value(env, "METRICS_INTERNAL_ADDRESSES")?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
    return {
        ingestUrl: ingestUrl(required(env, "OPS_INGEST_URL")),
        ingestToken,
        sellerStore: required(env, "SELLER_STORE_PATH"),
        facilitatorStore: required(env, "FACILITATOR_STORE_PATH"),
        metricsDb: required(env, "METRICS_DB_PATH"),
        cohortFile: value(env, "METRICS_COHORT_FILE"),
        snapshotDir: value(env, "METRICS_SNAPSHOT_DIR"),
        rpcUrl: parseNodeRpcUrl(value(env, "GIWA_SEPOLIA_RPC_URL") ?? giwaSepolia.rpcUrls.default.http[0]),
        // The public endpoint's limit, measured 2026-11-15: 10,001 blocks pass and 10,002 are
        // refused ("block range greater than 10000 max"). A provider plan can be tighter.
        logSpan: positive(env, "METRICS_LOG_SPAN", 10_000n),
        signer,
        sponsor,
        wallets,
        extraInternal: extra.map((a, i) => {
            if (!isAddress(a)) throw new Error(`METRICS_INTERNAL_ADDRESSES[${i}] must be an EVM address`);
            return getAddress(a);
        }),
        // The facilitator's own default; set it here when the facilitator's .env overrides it.
        relayerDailyWei: positive(env, "RELAYER_DAILY_WEI", 500_000_000_000_000n),
        walletMinWei: positive(env, "WALLET_MIN_WEI", 5_000_000_000_000_000n),
    };
}
