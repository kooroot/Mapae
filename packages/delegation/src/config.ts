import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {
    getAddress,
    isAddress,
    isHex,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import {giwaSepolia} from "@mapae/shared";
import {FRAMEWORK_COMPOSITION_ID} from "./composition.js";
import {ENTRY_POINT_V07} from "./network.js";

export {ENTRY_POINT_V07} from "./network.js";

export const DELEGATION_FRAMEWORK_VERSION = "1.3.0" as const;

export interface D3IdentityConfig {
    case1Owner: Address;
    case2Vendor: Address;
    frameworkAdmin: Address;
}

/** Stable CREATE2 salt for the owner's counterfactual HybridDeleGator account. */
export const OWNER_ACCOUNT_SALT =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

interface DelegationDeploymentArtifactBase {
    schemaVersion: 2;
    chainId: typeof giwaSepolia.id;
    frameworkVersion: typeof DELEGATION_FRAMEWORK_VERSION;
    compositionId: typeof FRAMEWORK_COMPOSITION_ID;
    environment: SmartAccountsEnvironment;
}

export interface PendingDelegationDeploymentArtifact
    extends DelegationDeploymentArtifactBase {
    state: "ownership-pending";
    admin: {
        deployer: Address;
        owner: Address;
        pendingOwner: Address;
        ownershipTransferTransaction: Hex;
        verificationBlock: string;
    };
}

export interface ActiveDelegationDeploymentArtifact
    extends DelegationDeploymentArtifactBase {
    state: "active";
    admin: {
        deployer: Address;
        owner: Address;
        pendingOwner: null;
        ownershipTransferTransaction: Hex;
        ownershipAcceptanceTransaction: Hex;
        verificationBlock: string;
    };
}

export type DelegationDeploymentArtifact =
    | PendingDelegationDeploymentArtifact
    | ActiveDelegationDeploymentArtifact;

const REQUIRED_IMPLEMENTATIONS = ["HybridDeleGatorImpl"] as const;
const REQUIRED_ENFORCERS = [
    "ValueLteEnforcer",
    "ERC20PeriodTransferEnforcer",
    "ERC20TransferAmountEnforcer",
    "AllowedCalldataEnforcer",
    "TimestampEnforcer",
    "RedeemerEnforcer",
] as const;

function checkedAddress(value: unknown, field: string): Address {
    if (typeof value !== "string" || !isAddress(value)) {
        throw new Error(`${field} must be an EVM address`);
    }
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error(`${field} must not be the zero address`);
    return address;
}

function checkedTransactionHash(value: unknown, field: string): Hex {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${field} must be a transaction hash`);
    }
    return value as Hex;
}

function checkedBlockNumber(value: unknown, field: string): string {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
        throw new Error(`${field} must be a decimal block number`);
    }
    return value;
}

/** Parse public role addresses supplied by an application or deployment environment. */
export function parseD3IdentityConfig(input: unknown): D3IdentityConfig {
    if (!input || typeof input !== "object") {
        throw new Error("D3 identity config must be an object");
    }
    const value = input as Record<string, unknown>;
    return {
        case1Owner: checkedAddress(value.case1Owner, "case1Owner"),
        case2Vendor: checkedAddress(value.case2Vendor, "case2Vendor"),
        frameworkAdmin: checkedAddress(value.frameworkAdmin, "frameworkAdmin"),
    };
}

/**
 * Parse an untrusted deployment JSON before any signer or facilitator uses it.
 *
 * GIWA is not in MetaMask's bundled deployment map yet, so our deployment artifact
 * is the trust boundary. Rejecting a wrong manager here prevents a payment payload
 * from selecting an attacker-controlled contract.
 */
export function parseDeploymentArtifact(input: unknown): DelegationDeploymentArtifact {
    if (!input || typeof input !== "object") throw new Error("deployment must be an object");
    const value = input as Record<string, unknown>;

    if (value.schemaVersion !== 2) {
        throw new Error("deployment.schemaVersion must be 2");
    }
    if (value.state !== "ownership-pending" && value.state !== "active") {
        throw new Error("deployment.state must be ownership-pending or active");
    }
    if (value.chainId !== giwaSepolia.id) {
        throw new Error(`deployment.chainId must be ${giwaSepolia.id}`);
    }
    if (value.frameworkVersion !== DELEGATION_FRAMEWORK_VERSION) {
        throw new Error(
            `deployment.frameworkVersion must be ${DELEGATION_FRAMEWORK_VERSION}`,
        );
    }
    if (value.compositionId !== FRAMEWORK_COMPOSITION_ID) {
        throw new Error(`deployment.compositionId must be ${FRAMEWORK_COMPOSITION_ID}`);
    }
    if (!value.environment || typeof value.environment !== "object") {
        throw new Error("deployment.environment must be an object");
    }

    const raw = value.environment as Record<string, unknown>;
    const entryPoint = checkedAddress(raw.EntryPoint, "environment.EntryPoint");
    if (entryPoint !== getAddress(ENTRY_POINT_V07)) {
        throw new Error(`environment.EntryPoint must be canonical v0.7 ${ENTRY_POINT_V07}`);
    }

    const implementations =
        raw.implementations && typeof raw.implementations === "object"
            ? (raw.implementations as Record<string, unknown>)
            : {};
    const caveatEnforcers =
        raw.caveatEnforcers && typeof raw.caveatEnforcers === "object"
            ? (raw.caveatEnforcers as Record<string, unknown>)
            : {};

    const checkedImplementations: Record<string, Hex> = {};
    for (const [name, address] of Object.entries(implementations)) {
        checkedImplementations[name] = checkedAddress(
            address,
            `environment.implementations.${name}`,
        );
    }
    for (const name of REQUIRED_IMPLEMENTATIONS) {
        if (!checkedImplementations[name]) {
            throw new Error(`environment.implementations.${name} is required`);
        }
    }

    const checkedEnforcers: Record<string, Hex> = {};
    for (const [name, address] of Object.entries(caveatEnforcers)) {
        checkedEnforcers[name] = checkedAddress(
            address,
            `environment.caveatEnforcers.${name}`,
        );
    }
    for (const name of REQUIRED_ENFORCERS) {
        if (!checkedEnforcers[name]) {
            throw new Error(`environment.caveatEnforcers.${name} is required`);
        }
    }

    const environment: SmartAccountsEnvironment = {
        DelegationManager: checkedAddress(
            raw.DelegationManager,
            "environment.DelegationManager",
        ),
        EntryPoint: entryPoint,
        SimpleFactory: checkedAddress(raw.SimpleFactory, "environment.SimpleFactory"),
        implementations: checkedImplementations,
        caveatEnforcers: checkedEnforcers,
    };

    if (!value.admin || typeof value.admin !== "object") {
        throw new Error("deployment.admin must be an object");
    }
    const rawAdmin = value.admin as Record<string, unknown>;
    const deployer = checkedAddress(rawAdmin.deployer, "deployment.admin.deployer");
    const owner = checkedAddress(rawAdmin.owner, "deployment.admin.owner");
    const ownershipTransferTransaction = checkedTransactionHash(
        rawAdmin.ownershipTransferTransaction,
        "deployment.admin.ownershipTransferTransaction",
    );
    const verificationBlock = checkedBlockNumber(
        rawAdmin.verificationBlock,
        "deployment.admin.verificationBlock",
    );

    const base = {
        schemaVersion: 2 as const,
        chainId: giwaSepolia.id,
        frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
        compositionId: FRAMEWORK_COMPOSITION_ID,
        environment,
    };
    if (value.state === "ownership-pending") {
        const pendingOwner = checkedAddress(
            rawAdmin.pendingOwner,
            "deployment.admin.pendingOwner",
        );
        if (owner !== deployer) {
            throw new Error("pending deployment owner must still be the deployer");
        }
        return {
            ...base,
            state: "ownership-pending",
            admin: {
                deployer,
                owner,
                pendingOwner,
                ownershipTransferTransaction,
                verificationBlock,
            },
        };
    }

    if (rawAdmin.pendingOwner !== null) {
        throw new Error("active deployment pendingOwner must be null");
    }
    const ownershipAcceptanceTransaction = checkedTransactionHash(
        rawAdmin.ownershipAcceptanceTransaction,
        "deployment.admin.ownershipAcceptanceTransaction",
    );
    return {
        ...base,
        state: "active",
        admin: {
            deployer,
            owner,
            pendingOwner: null,
            ownershipTransferTransaction,
            ownershipAcceptanceTransaction,
            verificationBlock,
        },
    };
}

export function parseDeploymentArtifactJson(json: string): DelegationDeploymentArtifact {
    let value: unknown;
    try {
        value = JSON.parse(json);
    } catch {
        throw new Error("deployment artifact is not valid JSON");
    }
    return parseDeploymentArtifact(value);
}

export function parseActiveDeploymentArtifact(
    input: unknown,
): ActiveDelegationDeploymentArtifact {
    const artifact = parseDeploymentArtifact(input);
    if (artifact.state !== "active") {
        throw new Error("deployment is not active; Framework ownership is still pending");
    }
    return artifact;
}

export function parseActiveDeploymentArtifactJson(
    json: string,
): ActiveDelegationDeploymentArtifact {
    let value: unknown;
    try {
        value = JSON.parse(json);
    } catch {
        throw new Error("deployment artifact is not valid JSON");
    }
    return parseActiveDeploymentArtifact(value);
}

export function isPermissionContext(value: unknown): value is Hex {
    return (
        typeof value === "string" &&
        isHex(value) &&
        value.length > 2 &&
        value.length <= 131_074
    );
}
