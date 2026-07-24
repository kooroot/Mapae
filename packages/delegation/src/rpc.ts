import {http, type HttpTransportConfig, type Transport} from "viem";

/**
 * The public GIWA Sepolia RPC rejects bursts of roughly ten concurrent reads with a
 * JSON-RPC `over rate limit` error rather than an HTTP 429, so viem's own retry never
 * engages. Verifying one deployment means reading 39 transactions, 39 receipts, and 38
 * runtime codes, which is far past that ceiling.
 *
 * This serializes every request through one paced queue and retries only rate-limit
 * responses. Any other failure is a real verification failure and propagates
 * immediately — a verifier that silently swallowed errors would be worse than a slow
 * one.
 */
export interface ThrottledHttpOptions {
    /** Delay inserted after each successful request. */
    paceMs?: number;
    /** Attempts per request before giving up. */
    maxAttempts?: number;
    /** Upper bound on exponential backoff between attempts. */
    maxBackoffMs?: number;
}

const DEFAULT_PACE_MS = 400;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_MAX_BACKOFF_MS = 15_000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rate-limit signals arrive as a message, a `details` field, or a nested cause. */
export function isRateLimitError(error: unknown): boolean {
    const parts: string[] = [];
    let current: unknown = error;
    let depth = 0;
    while (current instanceof Error && depth < 8) {
        parts.push(current.message);
        const details = (current as {details?: unknown}).details;
        if (typeof details === "string") parts.push(details);
        current = (current as {cause?: unknown}).cause;
        depth += 1;
    }
    return /over rate limit|rate.?limit|429|too many requests/i.test(parts.join(" "));
}

export function throttledHttp(
    url: string,
    options: ThrottledHttpOptions = {},
    httpConfig?: HttpTransportConfig,
): Transport {
    const paceMs = options.paceMs ?? DEFAULT_PACE_MS;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const inner = http(url, httpConfig);

    return (config) => {
        const transport = inner(config);
        // Requests are chained rather than run concurrently; the queue is the throttle.
        let queue: Promise<unknown> = Promise.resolve();

        const send = async (args: Parameters<typeof transport.request>[0]) => {
            let lastError: unknown;
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                if (attempt > 0) {
                    await delay(Math.min(500 * 2 ** attempt, maxBackoffMs));
                }
                try {
                    const result = await transport.request(args);
                    if (paceMs > 0) await delay(paceMs);
                    return result;
                } catch (error) {
                    lastError = error;
                    if (!isRateLimitError(error)) throw error;
                }
            }
            throw lastError;
        };

        return {
            ...transport,
            request: ((args: Parameters<typeof transport.request>[0]) => {
                const run = () => send(args);
                const next = queue.then(run, run);
                // Keep the chain alive after a rejection so later reads still run.
                queue = next.then(
                    () => undefined,
                    () => undefined,
                );
                return next;
            }) as typeof transport.request,
        };
    };
}
