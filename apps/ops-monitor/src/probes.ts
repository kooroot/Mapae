/**
 * The public probes, shared by the Worker cron and `scripts/ops/check.ts`.
 *
 * Runtime-neutral on purpose: it touches nothing but `fetch`, so the Worker and the CLI
 * judge "healthy" with one piece of code. A check that exists twice drifts, and the copy
 * that drifted is always the one paging you. Local-disk space stays in the CLI — a Worker
 * has no disk, and the remote server's disk is not something an outside probe can see.
 */
import {MOCK_USDC} from "../../../packages/shared/src/token";
import {GIWA_SEPOLIA_CAIP2} from "../../../packages/shared/src/chain";
import {parseFaucetStatus} from "../../../packages/delegation/src/faucet-policy";

export type ProbeKind = "health" | "profile" | "ticket" | "page" | "faucet";

export const PROBE_TARGETS = [
    {name: "web", url: "https://mapae.io/ko/arcade", kind: "page"},
    {name: "seller", url: "https://seller.mapae.io/health", kind: "health"},
    {name: "facilitator", url: "https://facilitator.mapae.io/health", kind: "health"},
    {name: "profile-auth", url: "https://mapae.io/api/arcade/profile/session", kind: "profile"},
    {name: "ticket", url: "https://mapae.io/api/arcade/giwa/stamp", kind: "ticket"},
    {name: "faucet", url: "https://faucet.mapae.io/api/faucet/status", kind: "faucet"},
] as const satisfies readonly {name: string; url: string; kind: ProbeKind}[];

export const METRICS_SERVICES = ["seller", "facilitator"] as const;
export type MetricsKeys = Record<(typeof METRICS_SERVICES)[number], string>;

/** Narrower than `typeof fetch`, so a test double does not have to fake Bun's extras. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProbeCheck {
    name: string;
    ok: boolean;
    status: number;
    ms: number;
}

const TIMEOUT_MS = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

export function validProbe(kind: ProbeKind, response: Response, value: unknown): boolean {
    if (kind === "page") return response.status === 200;
    // A faucet tab the service turned off (an empty wallet, a broken mint) is red.
    if (kind === "faucet") {
        if (response.status !== 200) return false;
        try {
            const status = parseFaucetStatus(value);
            return status.musdc.enabled && status.eth.enabled;
        } catch {return false;}
    }
    // The profile endpoint must refuse an anonymous caller; a 200 here means private data is public.
    if (kind === "profile") return response.status === 401 && isRecord(value) && JSON.stringify(value.error) === '{"code":"login_required"}';
    if (!isRecord(value)) return false;
    if (kind === "health") return response.status === 200 && value.ok === true;
    if (response.status !== 402 || !Array.isArray(value.accepts)) return false;
    return value.accepts.some(v => isRecord(v) && v.network === GIWA_SEPOLIA_CAIP2 && v.amount === "1000000"
        && typeof v.asset === "string" && v.asset.toLowerCase() === MOCK_USDC.address.toLowerCase());
}

const DECIMAL = /^\d{1,78}$/;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Seller: the orders section exists. Facilitator: more than 10% of the relayer's daily gas
 * budget remains, and fewer than 20% of the last day's attempts failed once there are at
 * least 20 (below that, two rejected requests would read as an incident).
 */
export function metricsHealthy(service: (typeof METRICS_SERVICES)[number], value: unknown): boolean {
    if (!isRecord(value)) return false;
    if (service === "seller") return value.orders !== undefined && value.orders !== null;
    const {budget, last24h} = value;
    if (!isRecord(budget) || !isRecord(last24h)) return false;
    if (typeof budget.remainingWei !== "string" || typeof budget.limitWei !== "string" || !DECIMAL.test(budget.remainingWei) || !DECIMAL.test(budget.limitWei)) return false;
    if (!count(last24h.failed) || !count(last24h.total)) return false;
    return BigInt(budget.remainingWei) > BigInt(budget.limitWei) / 10n
        && (last24h.total < 20 || last24h.failed / last24h.total < .2);
}

/**
 * Redirects are never followed and a 3xx is a failure. Following one would forward the
 * metrics bearer token to wherever it points, and a probe that lands on a login page or a
 * parked domain is not a healthy service. `manual` rather than `error` because it behaves
 * the same in Bun and workerd; the explicit 3xx check makes the outcome identical.
 */
const fetchProbe = (fetcher: Fetcher, url: string, init: RequestInit = {}) =>
    fetcher(url, {...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS)});

async function judge(name: string, response: Response, start: number, decide: () => Promise<boolean>): Promise<ProbeCheck> {
    const ok = response.status >= 300 && response.status < 400 ? (await response.body?.cancel(), false) : await decide();
    return {name, ok, status: response.status, ms: Date.now() - start};
}

export async function runProbes(fetcher: Fetcher, metricsKeys?: MetricsKeys): Promise<ProbeCheck[]> {
    const publicChecks = PROBE_TARGETS.map(async ({name, url, kind}): Promise<ProbeCheck> => {
        const start = Date.now();
        try {
            const response = await fetchProbe(fetcher, url);
            return await judge(name, response, start, async () => {
                // A non-JSON body (a proxy's HTML 503) fails the probe but keeps its status for the alert.
                const value: unknown = kind === "page" ? (await response.body?.cancel(), null) : await response.json().catch(() => null);
                return validProbe(kind, response, value);
            });
        } catch {
            return {name, ok: false, status: 0, ms: Date.now() - start};
        }
    });
    const metricsChecks = metricsKeys ? METRICS_SERVICES.map(async (service): Promise<ProbeCheck> => {
        const name = `${service}-metrics`, start = Date.now();
        try {
            const response = await fetchProbe(fetcher, `https://${service}.mapae.io/metrics`, {headers: {Authorization: `Bearer ${metricsKeys[service]}`}});
            return await judge(name, response, start, async () => response.ok ? metricsHealthy(service, await response.json().catch(() => null)) : (await response.body?.cancel(), false));
        } catch {
            // Secrets and upstream response details are never surfaced.
            return {name, ok: false, status: 0, ms: Date.now() - start};
        }
    }) : [];
    return Promise.all([...publicChecks, ...metricsChecks]);
}
