/**
 * Who is who. Three columns exist because "40 payments" means nothing until it is split
 * into the team's own testing, the invited cohort, and strangers — and only the last one
 * is evidence of demand.
 *
 * Internal is assembled from sources that already exist rather than a hand-kept list: the
 * deployment artifacts, the D3 session addresses, the arcade's fixed payee, the seller's
 * own `internal` shops, and the wallet names every funded service already reads. A list
 * someone has to remember to update is a list that silently misfiles the next wallet.
 */
import {existsSync, readFileSync} from "node:fs";
import {ARCADE_PAY_TO, ARCADE_REDEEMER} from "@mapae/arcade/tickets";
import {parseActiveDeploymentArtifactJson} from "@mapae/delegation/config";
import {getAddress, isAddress, type Address, type Hex} from "viem";
import type {Classifier} from "./metrics";

const DEPLOYMENTS = new URL("../../deployments/", import.meta.url);

function address(value: unknown, field: string): Address {
    if (typeof value !== "string" || !isAddress(value)) throw new Error(`${field} must be an EVM address`);
    return getAddress(value);
}

const readJson = (name: string): unknown => JSON.parse(readFileSync(new URL(name, DEPLOYMENTS), "utf8"));

export interface Deployment {
    delegationManager: Address;
    simpleFactory: Address;
    /** The transaction that created the first Framework unit; its block starts the index. */
    firstTransaction: Hex;
    /** Every address the artifacts name as ours. */
    internal: Address[];
}

export function loadDeployment(): Deployment {
    const framework = parseActiveDeploymentArtifactJson(readFileSync(new URL("giwa-sepolia.framework.json", DEPLOYMENTS), "utf8"));
    const owner = readJson("giwa-sepolia.owner-account.json") as Record<string, unknown>;
    const sessions = readJson("d3-session-addresses.json");
    const journal = readJson("giwa-sepolia.framework-chain-journal.json") as {receipts?: unknown};
    const first = Array.isArray(journal.receipts) ? (journal.receipts[0] as Record<string, unknown> | undefined)?.transactionHash : undefined;
    if (typeof first !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(first)) throw new Error("framework chain journal has no first transaction");
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) throw new Error("d3-session-addresses.json must be an object");
    const simpleFactory = framework.environment.SimpleFactory;
    return {
        delegationManager: getAddress(framework.environment.DelegationManager),
        simpleFactory: address(simpleFactory, "environment.SimpleFactory"),
        firstTransaction: first as Hex,
        internal: [
            framework.admin.deployer,
            framework.admin.owner,
            address(owner.account, "owner-account.account"),
            address(owner.owner, "owner-account.owner"),
            ...Object.entries(sessions).map(([role, value]) => address(value, `d3-session-addresses.${role}`)),
            getAddress(ARCADE_PAY_TO),
            getAddress(ARCADE_REDEEMER),
        ],
    };
}

/**
 * The cohort file lives outside the repository (internal-docs): it names real
 * participants. A JSON array of addresses. Absent is a valid state — before invitations
 * go out there is no cohort — and is reported as such rather than as an empty file.
 */
export function loadCohort(path: string | undefined): {addresses: Address[]; source: "file" | "missing"} {
    if (!path || !existsSync(path)) return {addresses: [], source: "missing"};
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new Error("METRICS_COHORT_FILE is not valid JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("METRICS_COHORT_FILE must be a JSON array of addresses");
    return {addresses: parsed.map((v, i) => address(v, `METRICS_COHORT_FILE[${i}]`)), source: "file"};
}

export function buildClassifier(internal: readonly string[], cohort: readonly string[]): Classifier {
    return {
        internal: new Set(internal.map(a => a.toLowerCase())),
        cohort: new Set(cohort.map(a => a.toLowerCase())),
    };
}
