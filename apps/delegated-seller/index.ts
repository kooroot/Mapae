import {createMapae} from "@mapae/seller";
import {isLoopbackHost} from "@mapae/shared";
import {openStore} from "@mapae/store";
import {createShopApp} from "./app.js";
import {readStorePath} from "./env.js";

/**
 * Timeout budgets, and why the idle timeout is set explicitly.
 *
 * Four timeouts stack on one payment, and they have to grow outward:
 *
 *   facilitator receipt wait  <  paywall's settle call  <  this server's idle
 *   timeout  <  the agent's own request timeout
 *
 * They were inverted once. `Bun.serve`'s **default `idleTimeout` is 10 s**, which made
 * the outermost hop the shortest while the facilitator waited up to 60 s for a receipt.
 * On GIWA that produced the worst available outcome: the transfer was mined
 * (`0x533c5cb2…9964c`, block 31634935, payer −1.00 tUSDC) and the agent was told the
 * payment had failed. An inverted budget does not lose a payment — it loses the *answer*
 * about a payment, which is harder to recover from.
 *
 * `@mapae/seller` gives `/settle` 35 s. The idle timeout must exceed that, or this server
 * hangs up on its own settlement. It is in seconds and capped at 255 by Bun.
 */
const SETTLE_TIMEOUT_SECONDS = 35;
const MIN_METRICS_TOKEN_LENGTH = 16;

function readInteger(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}

/**
 * The origin buyers reach this server at. Behind a tunnel it has to be given: every
 * 402 and every manifest names item URLs on it, and `http://127.0.0.1:3001/…` is not a
 * URL a buyer can call. A loopback server may default to itself.
 */
function readBaseUrl(host: string, port: number): string {
    const value = process.env.BASE_URL?.trim();
    if (value) {
        const url = new URL(value);
        if (url.pathname !== "/" || url.search || url.hash) {
            throw new Error("BASE_URL must be an origin — scheme://host[:port] — with no path, query or fragment");
        }
        return url.origin;
    }
    if (!isLoopbackHost(host)) {
        throw new Error("BASE_URL must be set when HOST is not loopback — buyers see it in every 402");
    }
    return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function readMetricsToken(): string | undefined {
    const token = process.env.METRICS_TOKEN?.trim();
    if (!token) return undefined;
    if (token.length < MIN_METRICS_TOKEN_LENGTH) {
        throw new Error(`METRICS_TOKEN must be at least ${MIN_METRICS_TOKEN_LENGTH} characters`);
    }
    return token;
}

const HOST = process.env.HOST?.trim() || "127.0.0.1";
const PORT = readInteger("PORT", 3001, 1, 65_535);
const IDLE_TIMEOUT_SECONDS = readInteger("IDLE_TIMEOUT_SECONDS", 45, SETTLE_TIMEOUT_SECONDS + 1, 255);
const STORE_PATH = readStorePath();
// Validated by createMapae: HTTP(S), no credentials, HTTPS unless loopback.
const FACILITATOR_URL = process.env.FACILITATOR_URL?.trim() || "http://127.0.0.1:8081";
const BASE_URL = readBaseUrl(HOST, PORT);
const METRICS_TOKEN = readMetricsToken();
const NAME = "Mapae hosted shop";

const store = openStore(STORE_PATH);
const mapae = createMapae({facilitator: FACILITATOR_URL, baseUrl: BASE_URL});
const app = createShopApp({store, mapae, baseUrl: BASE_URL, name: NAME, metricsToken: METRICS_TOKEN});

const shops = store.sellers.list().filter((seller) => seller.kind === "hosted");
console.log(`delegated seller listening on ${HOST}:${PORT}`);
console.log(`  base URL    ${BASE_URL}`);
console.log(`  facilitator ${mapae.facilitator}`);
console.log(`  store       ${STORE_PATH}`);
console.log(`  shops       ${shops.length === 0 ? "none — run `bun run seed`" : shops.map((seller) => seller.slug).join(", ")}`);
console.log(`  metrics     ${METRICS_TOKEN === undefined ? "disabled (METRICS_TOKEN unset)" : "enabled"}`);
export default {
    hostname: HOST,
    port: PORT,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch: app.fetch,
};
