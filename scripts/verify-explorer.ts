/**
 * Ask the explorer what it actually published, for every address we deployed.
 *
 * `scripts/verify-framework.sh` *submits* source and reports what failed at submission
 * time. Nothing re-read the result afterwards, and the difference matters: submission
 * succeeding is not the same as the explorer ending up with source. Measured on
 * 2026-07-26, 38 of 39 addresses carry source and one — `SpecificActionERC20TransferBatchEnforcer`
 * — does not, despite being listed in that script and needing no constructor arguments.
 * A judge following the links in `docs/deployed-contracts.md` lands on it.
 *
 * Read-only on purpose. The submitting script writes to a third party, so it is not
 * something to run casually; this one can be run any time, by anyone, and answers the
 * question the README's "deployed and verified" actually makes.
 *
 * Not in `bun run check` — it needs the network and someone else's service, and the gate
 * promises neither. It belongs with `verify:framework` in the audit commands.
 */
const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const EXPLORER = "https://sepolia-explorer.giwa.io";

export type Verification = "full" | "partial" | "unverified" | "unknown";

export interface ContractStatus {
    verification: Verification;
    detail: string;
}

/**
 * Blockscout answers this question in three different shapes, so all three are handled
 * rather than assumed. A 404 is a definite "no source". A 200 whose `is_verified` is not
 * `true` is also a definite no — that is the shape the one unverified unit returns, and
 * treating only 404 as unverified would have reported it as verified.
 */
export function classifyContract(httpStatus: number, body: unknown): ContractStatus {
    if (httpStatus === 404) return {verification: "unverified", detail: "no source published"};
    if (httpStatus !== 200) return {verification: "unknown", detail: `HTTP ${httpStatus}`};
    if (!body || typeof body !== "object") return {verification: "unknown", detail: "unreadable response"};
    const contract = body as {
        is_verified?: boolean;
        is_partially_verified?: boolean;
        name?: string;
        compiler_version?: string;
    };
    if (contract.is_verified !== true) {
        return {verification: "unverified", detail: "explorer reports is_verified false"};
    }
    return {
        verification: contract.is_partially_verified === true ? "partial" : "full",
        detail: [contract.name, contract.compiler_version].filter(Boolean).join(" ") || "verified",
    };
}

interface Unit {
    name: string;
    address: string;
}

/**
 * Both sources of truth, exactly as `docs/deployed-contracts.md` describes them: the
 * manifest for the Framework, and `token.ts` for MockUSDC, which is in no artifact.
 */
async function deployedAddresses(): Promise<Unit[]> {
    const manifest = (await Bun.file(
        `${REPO}/deployments/giwa-sepolia.framework-manifest.json`,
    ).json()) as {deployments: {name: string; address: string}[]};
    const units: Unit[] = manifest.deployments.map(({name, address}) => ({name, address}));
    const token = await Bun.file(`${REPO}/packages/shared/src/token.ts`).text();
    const mockUsdc = /0x[0-9a-fA-F]{40}/.exec(token);
    if (mockUsdc) units.push({name: "MockUSDC", address: mockUsdc[0]});
    return units;
}

async function fetchStatus(address: string): Promise<ContractStatus> {
    try {
        const response = await fetch(`${EXPLORER}/api/v2/smart-contracts/${address}`, {
            headers: {accept: "application/json"},
            signal: AbortSignal.timeout(20_000),
        });
        const body = response.status === 200 ? await response.json() : undefined;
        return classifyContract(response.status, body);
    } catch {
        return {verification: "unknown", detail: "could not reach the explorer"};
    }
}

async function main(): Promise<void> {
    const units = await deployedAddresses();
    const results: {unit: Unit; status: ContractStatus}[] = [];
    // Four at a time, with a pause between batches — this is a public explorer we do not run.
    for (let index = 0; index < units.length; index += 4) {
        const batch = units.slice(index, index + 4);
        results.push(
            ...(await Promise.all(
                batch.map(async (unit) => ({unit, status: await fetchStatus(unit.address)})),
            )),
        );
    }

    const tally: Record<Verification, number> = {full: 0, partial: 0, unverified: 0, unknown: 0};
    for (const {status} of results) tally[status.verification] += 1;

    // Partial is the expected outcome for the Framework units — only the 32-byte IPFS
    // metadata digest differs, zero executable bytes — so listing all 37 would bury the
    // rows that need a decision.
    const notable = results.filter(({status}) => status.verification !== "partial");
    for (const {unit, status} of notable) {
        console.log(
            `  ${status.verification.toUpperCase().padEnd(10)} ${unit.name.padEnd(42)} ` +
                `${unit.address}  ${status.detail}`,
        );
    }

    console.log(
        `\n[explorer] ${results.length} deployed addresses — ` +
            `${tally.full} fully verified, ${tally.partial} partial, ` +
            `${tally.unverified} unverified, ${tally.unknown} unreadable`,
    );
    if (tally.unverified > 0) {
        console.log(
            "\nAn unverified address is a link in docs/deployed-contracts.md that lands on\n" +
                "bytecode with no source. Publishing source is a write to a third party —\n" +
                "`scripts/verify-framework.sh` does it for all 38 — so it is a deliberate act,\n" +
                "not something this read-only check should do on your behalf.",
        );
    }
    // Deliberately exits 0 even with unverified units: this reports the explorer's state,
    // and failing here would make an unrelated explorer outage look like our problem.
    process.exitCode = tally.unknown > 0 ? 1 : 0;
}

if (import.meta.main) await main();
