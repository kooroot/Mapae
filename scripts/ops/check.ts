import {statfsSync, statSync, readFileSync} from "node:fs";
import {runProbes, type Fetcher, type MetricsKeys} from "../../apps/ops-monitor/src/probes";

/** The shared public probes plus this machine's own disk, which only a local CLI can see. */
export async function check(fetcher: Fetcher = fetch, metricsKeys?: MetricsKeys) {
    const checks = await runProbes(fetcher, metricsKeys);
    const disk = statfsSync(process.cwd()), free = disk.bavail * disk.bsize;
    checks.push({name: "local-disk", ok: free >= 5 * 1024 ** 3 && disk.bavail / disk.blocks >= .1, status: 0, ms: 0});
    return {at: new Date().toISOString(), ok: checks.every(c => c.ok), checks, freeDiskBytes: free};
}
if (import.meta.main) {
    try {
        const [flag, path] = process.argv.slice(2);
        let keys: MetricsKeys | undefined;
        if (flag) {
            if (flag !== "--metrics-key-file" || !path || (statSync(path).mode & 0o077) !== 0) throw new Error("private_file_required");
            const value: unknown = JSON.parse(readFileSync(path, "utf8"));
            if (!value || typeof value !== "object" || !("seller" in value) || !("facilitator" in value) || typeof value.seller !== "string" || typeof value.facilitator !== "string" || value.seller.length < 16 || value.facilitator.length < 16) throw new Error("invalid_keys");
            keys = {seller: value.seller, facilitator: value.facilitator};
        }
        const result = await check(fetch, keys); console.log(JSON.stringify({...result, metricsChecked: !!keys}, null, 2)); process.exitCode = result.ok ? 0 : 1;
    } catch {console.error("Monitoring failed. Check the optional private metrics key file (chmod 600)."); process.exitCode = 1;}
}
