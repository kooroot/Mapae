import {
    Implementation,
    toMetaMaskSmartAccount,
    type Delegation,
    type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {decodeDelegations, encodeDelegations} from "@metamask/smart-accounts-kit/utils";
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
        chainId: giwaSepolia.id,
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
