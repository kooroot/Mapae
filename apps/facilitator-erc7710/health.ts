/** Bound HTTP readiness latency; the shared probe still owns/coalesces its underlying RPC. */
export async function healthDeadline<T>(promise: Promise<T>, milliseconds = 10_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {return await Promise.race([promise, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("health_timeout")), milliseconds);})]);}
    finally {if (timer) clearTimeout(timer);}
}
export function paymentReady(framework: boolean, database: boolean, balance: bigint | undefined, remaining: bigint): boolean {
    return framework && database && balance !== undefined && balance > 0n && remaining > 0n;
}
