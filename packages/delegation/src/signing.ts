import {
    Implementation,
    toMetaMaskSmartAccount,
    type Delegation,
    type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {
    SIGNABLE_DELEGATION_TYPED_DATA,
    decodeDelegations,
    encodeDelegations,
    toDelegationStruct,
} from "@metamask/smart-accounts-kit/utils";
import {
    signDelegation as signDelegationWithPrivateKey,
} from "@metamask/smart-accounts-kit";
import type {
    Account,
    Address,
    Chain,
    Hex,
    PublicClient,
    Transport,
    WalletClient,
} from "viem";
import {getAddress} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {giwaSepolia} from "@mapae/shared";
import {
    DELEGATION_FRAMEWORK_VERSION,
    OWNER_ACCOUNT_SALT,
} from "./config.js";
import {
    preparePeriodDelegation,
    withDelegationSignature,
    type PeriodPolicy,
} from "./policy.js";

export interface PermissionArtifact {
    frameworkVersion: typeof DELEGATION_FRAMEWORK_VERSION;
    chainId: typeof giwaSepolia.id;
    role: string;
    delegator: Address;
    delegate: Address;
    permissionContext: Hex;
    createdAt: number;
}

export async function toMapaeOwnerSmartAccount(params: {
    publicClient: PublicClient;
    walletClient: WalletClient<Transport, Chain, Account>;
    environment: SmartAccountsEnvironment;
    accountOwner: Address;
}) {
    const signer = getAddress(params.walletClient.account.address);
    const accountOwner = getAddress(params.accountOwner);
    if (signer !== accountOwner) {
        throw new Error(
            `wallet signer ${signer} is not configured account owner ${accountOwner}`,
        );
    }
    return toMetaMaskSmartAccount({
        client: params.publicClient,
        implementation: Implementation.Hybrid,
        signer: {walletClient: params.walletClient},
        environment: params.environment,
        deployParams: [accountOwner, [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });
}

/**
 * The connected wallet signs as the HybridDeleGator account owner; the smart account
 * is the delegation's on-chain delegator. This function never requests or handles
 * the owner's private key.
 */
export async function signRootPeriodPermission(params: {
    publicClient: PublicClient;
    walletClient: WalletClient<Transport, Chain, Account>;
    environment: SmartAccountsEnvironment;
    accountOwner: Address;
    delegate: Address;
    policy: PeriodPolicy;
    startDate: number;
}): Promise<PermissionArtifact> {
    const smartAccount = await toMapaeOwnerSmartAccount(params);
    const unsigned = preparePeriodDelegation({
        environment: params.environment,
        delegator: smartAccount.address,
        delegate: params.delegate,
        policy: params.policy,
        startDate: params.startDate,
    });
    const signature = await smartAccount.signDelegation({
        delegation: unsigned,
        chainId: giwaSepolia.id,
    });
    const signed = withDelegationSignature(unsigned, signature);
    return permissionArtifact(params.policy.role, [signed], params.startDate);
}

/**
 * EIP-712 typed data for a root period delegation, ready to be signed offline by the
 * account-owner wallet (e.g. Rabby via `eth_signTypedData_v4`).
 *
 * The domain, type set, primary type, and message are byte-identical to what
 * `smartAccount.signDelegation` produces internally and to what the on-chain
 * `DelegationManager` reconstructs when it verifies the delegation (name
 * `DelegationManager`, version `1`, verifyingContract = the manager). A signature over
 * this exact structure is what `redeemDelegations` validates through the deployed
 * HybridDeleGator's ERC-1271 `isValidSignature`. The equivalence is pinned by a unit
 * test against the SDK's own signer.
 */
export interface RootPermissionSigningRequest {
    role: string;
    delegator: Address;
    delegate: Address;
    startDate: number;
    unsignedDelegation: Delegation;
    typedData: RootDelegationTypedData;
}

export interface RootDelegationTypedData {
    domain: {
        name: "DelegationManager";
        version: "1";
        chainId: typeof giwaSepolia.id;
        verifyingContract: Address;
    };
    types: typeof SIGNABLE_DELEGATION_TYPED_DATA;
    primaryType: "Delegation";
    message: ReturnType<typeof toDelegationStruct>;
}

/**
 * Reconstruct the exact EIP-712 typed data for a delegation under a given manager.
 * Single source of truth for both the offline signing request and its later
 * verification, so the two can never disagree. The `name`/`version` literals are the
 * `DelegationManager` contract constants (`NAME`, `DOMAIN_VERSION`).
 */
export function buildRootDelegationTypedData(
    delegationManager: Address,
    delegation: Delegation,
): RootDelegationTypedData {
    return {
        domain: {
            name: "DelegationManager",
            version: "1",
            chainId: giwaSepolia.id,
            verifyingContract: getAddress(delegationManager),
        },
        types: SIGNABLE_DELEGATION_TYPED_DATA,
        primaryType: "Delegation",
        message: toDelegationStruct({...delegation, signature: "0x"}),
    };
}

/**
 * Build the unsigned root delegation and its EIP-712 typed data without a wallet or a
 * private key. The caller displays `typedData` for the owner wallet to sign and keeps
 * `unsignedDelegation` verbatim so the later assembly signs exactly what was shown.
 */
export function prepareRootPermissionSigningRequest(params: {
    environment: SmartAccountsEnvironment;
    accountOwnerSmartAccount: Address;
    delegate: Address;
    policy: PeriodPolicy;
    startDate: number;
}): RootPermissionSigningRequest {
    const delegator = getAddress(params.accountOwnerSmartAccount);
    const unsignedDelegation = preparePeriodDelegation({
        environment: params.environment,
        delegator,
        delegate: params.delegate,
        policy: params.policy,
        startDate: params.startDate,
    });
    return {
        role: params.policy.role,
        delegator,
        delegate: getAddress(params.delegate),
        startDate: params.startDate,
        unsignedDelegation,
        typedData: buildRootDelegationTypedData(
            params.environment.DelegationManager,
            unsignedDelegation,
        ),
    };
}

/**
 * Attach an offline owner-wallet signature to the exact unsigned delegation that was
 * shown for signing, producing the permission artifact a delegated agent consumes.
 * The signature is not trusted here; callers must verify it on-chain via the
 * delegator's ERC-1271 `isValidSignature` before relying on the artifact.
 */
export function assembleRootPermission(params: {
    role: string;
    unsignedDelegation: Delegation;
    signature: Hex;
    createdAt: number;
}): PermissionArtifact {
    const signed = withDelegationSignature(params.unsignedDelegation, params.signature);
    return permissionArtifact(params.role, [signed], params.createdAt);
}

/**
 * A manager session key can re-delegate to a child without involving the owner wallet again.
 * The child chain still consumes the manager's aggregate parent period bucket.
 */
export async function signChildPeriodPermission(params: {
    managerPrivateKey: Hex;
    managerAddress: Address;
    childAddress: Address;
    parentPermissionContext: Hex;
    environment: SmartAccountsEnvironment;
    policy: PeriodPolicy;
    startDate: number;
    /** Defaults to GIWA Sepolia; override to sign for a local Anvil / forked chain. */
    chainId?: number;
}): Promise<PermissionArtifact> {
    const managerSigner = privateKeyToAccount(params.managerPrivateKey);
    if (managerSigner.address !== getAddress(params.managerAddress)) {
        throw new Error("manager private key does not match managerAddress");
    }
    const parentChain = decodeDelegations(params.parentPermissionContext);
    const parent = parentChain[0];
    if (!parent || getAddress(parent.delegate) !== getAddress(params.managerAddress)) {
        throw new Error("parent permission is not delegated to the supplied manager");
    }
    const unsigned = preparePeriodDelegation({
        environment: params.environment,
        delegator: params.managerAddress,
        delegate: params.childAddress,
        policy: params.policy,
        startDate: params.startDate,
        parentPermissionContext: parentChain,
    });
    const signature = await signDelegationWithPrivateKey({
        privateKey: params.managerPrivateKey,
        delegation: unsigned,
        delegationManager: getAddress(params.environment.DelegationManager),
        chainId: params.chainId ?? giwaSepolia.id,
    });
    return permissionArtifact(
        params.policy.role,
        [withDelegationSignature(unsigned, signature), ...parentChain],
        params.startDate,
    );
}

function permissionArtifact(
    role: string,
    chain: Delegation[],
    createdAt: number,
): PermissionArtifact {
    const leaf = chain[0];
    const root = chain.at(-1);
    if (!leaf || !root) throw new Error("delegation chain must not be empty");
    return {
        frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
        chainId: giwaSepolia.id,
        role,
        delegator: getAddress(root.delegator),
        delegate: getAddress(leaf.delegate),
        permissionContext: encodeDelegations(chain),
        createdAt,
    };
}
