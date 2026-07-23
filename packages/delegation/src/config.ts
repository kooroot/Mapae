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

export const DELEGATION_FRAMEWORK_VERSION = "1.3.0" as const;

/** Canonical ERC-4337 EntryPoint v0.7, already deployed on GIWA Sepolia. */
export const ENTRY_POINT_V07 =
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;

export interface D3IdentityConfig {
    accountOwner: Address;
    frameworkAdmin: Address;
    fixedVendor: Address;
}

/** Stable CREATE2 salt for the owner's counterfactual HybridDeleGator account. */
export const OWNER_ACCOUNT_SALT =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

export interface DelegationDeploymentArtifact {
    chainId: typeof giwaSepolia.id;
    frameworkVersion: typeof DELEGATION_FRAMEWORK_VERSION;
    environment: SmartAccountsEnvironment;
    admin?: {
        owner: Address;
        pendingOwner?: Address;
    };
}

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

/** Parse public role addresses supplied by an application or deployment environment. */
export function parseD3IdentityConfig(input: unknown): D3IdentityConfig {
    if (!input || typeof input !== "object") {
        throw new Error("D3 identity config must be an object");
    }
    const value = input as Record<string, unknown>;
    return {
        accountOwner: checkedAddress(value.accountOwner, "accountOwner"),
        frameworkAdmin: checkedAddress(value.frameworkAdmin, "frameworkAdmin"),
        fixedVendor: checkedAddress(value.fixedVendor, "fixedVendor"),
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

    if (value.chainId !== giwaSepolia.id) {
        throw new Error(`deployment.chainId must be ${giwaSepolia.id}`);
    }
    if (value.frameworkVersion !== DELEGATION_FRAMEWORK_VERSION) {
        throw new Error(
            `deployment.frameworkVersion must be ${DELEGATION_FRAMEWORK_VERSION}`,
        );
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

    let admin: DelegationDeploymentArtifact["admin"];
    if (value.admin !== undefined) {
        if (!value.admin || typeof value.admin !== "object") {
            throw new Error("deployment.admin must be an object");
        }
        const rawAdmin = value.admin as Record<string, unknown>;
        admin = {
            owner: checkedAddress(rawAdmin.owner, "deployment.admin.owner"),
            ...(rawAdmin.pendingOwner === undefined
                ? {}
                : {
                      pendingOwner: checkedAddress(
                          rawAdmin.pendingOwner,
                          "deployment.admin.pendingOwner",
                      ),
                  }),
        };
    }

    return {
        chainId: giwaSepolia.id,
        frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
        environment,
        ...(admin ? {admin} : {}),
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

export function isPermissionContext(value: unknown): value is Hex {
    return (
        typeof value === "string" &&
        isHex(value) &&
        value.length > 2 &&
        value.length <= 131_074
    );
}
