import {statfsSync, statSync, readFileSync} from "node:fs";
import {MOCK_USDC, GIWA_SEPOLIA_CAIP2} from "../../packages/shared/src/index";

export function validProbe(kind: "health" | "profile" | "ticket" | "page", response: Response, value: unknown): boolean {
    if (kind === "page") return response.status === 200;
    if (kind === "profile") return response.status === 401 && !!value && typeof value === "object" && "error" in value && JSON.stringify(value.error) === '{"code":"login_required"}';
    if (!value || typeof value !== "object") return false;
    if (kind === "health") return response.status === 200 && "ok" in value && value.ok === true;
    if (response.status !== 402 || !("accepts" in value) || !Array.isArray(value.accepts)) return false;
    return value.accepts.some(v => v.network === GIWA_SEPOLIA_CAIP2 && v.amount === "1000000" && v.asset?.toLowerCase() === MOCK_USDC.address.toLowerCase());
}
export async function check(fetcher: typeof fetch = fetch, metricsKeys?: {seller: string; facilitator: string}) {
    const targets = [
        ["web", "https://mapae.io/ko/arcade", "page"],
        ["seller", "https://seller.mapae.io/health", "health"],
        ["facilitator", "https://facilitator.mapae.io/health", "health"],
        ["profile-auth", "https://mapae.io/api/arcade/profile", "profile"],
        ["ticket", "https://mapae.io/api/arcade/giwa/stamp", "ticket"],
    ] as const;
    const checks: {name: string; ok: boolean; status: number; ms: number}[] = await Promise.all(targets.map(async ([name, url, kind]) => {
        const start = Date.now();
        try {
            const response = await fetcher(url, {redirect: "error", signal: AbortSignal.timeout(15_000)});
            const value: unknown = kind === "page" ? (await response.body?.cancel(), null) : await response.json();
            return {name, ok: validProbe(kind, response, value), status: response.status, ms: Date.now() - start};
        } catch {return {name, ok: false, status: 0, ms: Date.now() - start};}
    }));
    if (metricsKeys) {
        for (const name of ["seller", "facilitator"] as const) {
            let ok = false;
            try {
                const response = await fetcher(`https://${name}.mapae.io/metrics`, {headers: {Authorization: `Bearer ${metricsKeys[name]}`}, redirect: "error", signal: AbortSignal.timeout(15_000)});
                const value = await response.json() as {budget?: {remainingWei: string; limitWei: string}; last24h?: {failed: number; total: number}; orders?: unknown};
                ok = response.ok && (name === "seller" ? !!value.orders : !!value.budget && BigInt(value.budget.remainingWei) > BigInt(value.budget.limitWei) / 10n && !!value.last24h && (value.last24h.total < 20 || value.last24h.failed / value.last24h.total < .2));
            } catch { /* Secrets and upstream response details are never printed. */ }
            checks.push({name: `${name}-metrics`, ok, status: 0, ms: 0});
        }
    }
    const disk = statfsSync(process.cwd()), free = disk.bavail * disk.bsize;
    checks.push({name: "local-disk", ok: free >= 5 * 1024 ** 3 && disk.bavail / disk.blocks >= .1, status: 0, ms: 0});
    return {at: new Date().toISOString(), ok: checks.every(c => c.ok), checks, freeDiskBytes: free};
}
if (import.meta.main) {
    try {
        const [flag, path] = process.argv.slice(2);
        let keys: {seller: string; facilitator: string} | undefined;
        if (flag) {
            if (flag !== "--metrics-key-file" || !path || (statSync(path).mode & 0o077) !== 0) throw new Error("private_file_required");
            const value: unknown = JSON.parse(readFileSync(path, "utf8"));
            if (!value || typeof value !== "object" || !("seller" in value) || !("facilitator" in value) || typeof value.seller !== "string" || typeof value.facilitator !== "string" || value.seller.length < 16 || value.facilitator.length < 16) throw new Error("invalid_keys");
            keys = {seller: value.seller, facilitator: value.facilitator};
        }
        const result = await check(fetch, keys); console.log(JSON.stringify({...result, metricsChecked: !!keys}, null, 2)); process.exitCode = result.ok ? 0 : 1;
    } catch {console.error("Monitoring failed. Check the optional private metrics key file (chmod 600)."); process.exitCode = 1;}
}
