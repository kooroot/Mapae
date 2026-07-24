import {
    DelegationManager as DelegationManagerAbi,
    EIP7702StatelessDeleGator as EIP7702StatelessDeleGatorAbi,
    HybridDeleGator as HybridDeleGatorAbi,
    MultiSigDeleGator as MultiSigDeleGatorAbi,
    NativeTokenPaymentEnforcer as NativeTokenPaymentEnforcerAbi,
} from "@metamask/delegation-abis";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {
    getAddress,
    keccak256,
    zeroAddress,
    type Abi,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import {
    FRAMEWORK_COMPONENT_BY_NAME,
    FRAMEWORK_COMPOSITION_ID,
    FRAMEWORK_COMPOSITION_SPEC_HASH,
    FRAMEWORK_DEPLOYMENT_COUNT,
    FRAMEWORK_DEPLOYMENT_ORDER,
    extractRuntimeLinkAddresses,
    verifyFrameworkRuntimeCode,
    verifyGiwaEntryPointRuntimeCode,
    verifySclRuntimeSelfAddress,
    type FrameworkDeploymentName,
} from "./composition.js";
import {
    DELEGATION_FRAMEWORK_VERSION,
    type ActiveDelegationDeploymentArtifact,
} from "./config.js";
import type {FrameworkDeploymentManifest} from "./deployment-record.js";

const EIP1967_IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

export const OWNER_ACCOUNT_PROXY_RUNTIME_CODE_HASH =
    "0x8678a7d794f76a790255c0db52d6276dc7259cc7a211426bca106e5ebb4b1ddf" as Hex;

export interface ExpectedFrameworkAdminState {
    owner: Address;
    pendingOwner: Address | null;
    paused: boolean;
}

export interface FrameworkLiveVerification {
    chainId: number;
    blockNumber: string;
    compositionId: typeof FRAMEWORK_COMPOSITION_ID;
    delegationManager: Address;
    entryPoint: Address;
    owner: Address;
    pendingOwner: Address | null;
    paused: boolean;
}

export interface OwnerAccountVerification {
    chainId: number;
    blockNumber: string;
    account: Address;
    owner: Address;
    implementation: Address;
    delegationManager: Address;
    entryPoint: Address;
    initializedVersion: string;
    p256KeyCount: string;
    runtimeCodeHash: Hex;
}

export async function verifyActiveFrameworkDeployment(params: {
    publicClient: PublicClient;
    deployment: ActiveDelegationDeploymentArtifact;
    manifest: FrameworkDeploymentManifest;
    expectedFrameworkAdmin: Address;
    blockNumber?: bigint;
}): Promise<FrameworkLiveVerification> {
    const expectedAdmin = getAddress(params.expectedFrameworkAdmin);
    if (
        params.deployment.compositionId !== params.manifest.compositionId ||
        params.deployment.chainId !== params.manifest.chainId ||
        params.deployment.admin.owner !== expectedAdmin ||
        params.deployment.admin.pendingOwner !== null
    ) {
        throw new Error("active deployment artifact does not match its manifest or admin");
    }
    const live = await verifyFrameworkLiveState({
        publicClient: params.publicClient,
        manifest: params.manifest,
        environment: params.deployment.environment,
        expectedAdmin: {
            owner: expectedAdmin,
            pendingOwner: null,
            paused: false,
        },
        ...(params.blockNumber === undefined
            ? {}
            : {blockNumber: params.blockNumber}),
    });
    if (BigInt(live.blockNumber) < BigInt(params.deployment.admin.verificationBlock)) {
        throw new Error("live verification block predates the active artifact");
    }
    return live;
}

/**
 * Lightweight operational refresh used after the full startup verification.
 * It rechecks the immutable manager runtime, GIWA EntryPoint, and all mutable
 * admin controls without issuing 38 code reads on every payment request.
 */
export async function verifyFrameworkOperationalState(params: {
    publicClient: PublicClient;
    deployment: ActiveDelegationDeploymentArtifact;
    expectedFrameworkAdmin: Address;
}): Promise<FrameworkLiveVerification> {
    const chainId = await params.publicClient.getChainId();
    if (chainId !== params.deployment.chainId) {
        throw new Error("operational RPC chain does not match the active deployment");
    }
    const blockNumber = await params.publicClient.getBlockNumber({cacheTime: 0});
    const manager = getAddress(params.deployment.environment.DelegationManager);
    const entryPoint = getAddress(params.deployment.environment.EntryPoint);
    const expectedAdmin = getAddress(params.expectedFrameworkAdmin);
    if (
        params.deployment.admin.owner !== expectedAdmin ||
        params.deployment.admin.pendingOwner !== null
    ) {
        throw new Error("active deployment admin identity mismatch");
    }
    const [managerCode, entryPointCode, name, version, domainVersion, ownerValue, pendingValue, pausedValue] =
        await Promise.all([
            params.publicClient.getCode({address: manager, blockNumber}),
            params.publicClient.getCode({address: entryPoint, blockNumber}),
            readFunction(
                params.publicClient,
                manager,
                DelegationManagerAbi,
                "NAME",
                blockNumber,
            ),
            readFunction(
                params.publicClient,
                manager,
                DelegationManagerAbi,
                "VERSION",
                blockNumber,
            ),
            readFunction(
                params.publicClient,
                manager,
                DelegationManagerAbi,
                "DOMAIN_VERSION",
                blockNumber,
            ),
            readFunction(
                params.publicClient,
                manager,
                DelegationManagerAbi,
                "owner",
                blockNumber,
            ),
            readFunction(
                params.publicClient,
                manager,
                DelegationManagerAbi,
                "pendingOwner",
                blockNumber,
            ),
            readFunction(
                params.publicClient,
                manager,
                DelegationManagerAbi,
                "paused",
                blockNumber,
            ),
        ]);
    if (!managerCode || managerCode === "0x") {
        throw new Error("DelegationManager has no operational runtime");
    }
    verifyFrameworkRuntimeCode("DelegationManager", managerCode);
    if (!entryPointCode || entryPointCode === "0x") {
        throw new Error("EntryPoint has no operational runtime");
    }
    if (chainId === 91_342) verifyGiwaEntryPointRuntimeCode(entryPointCode);
    if (
        name !== "DelegationManager" ||
        version !== DELEGATION_FRAMEWORK_VERSION ||
        domainVersion !== "1" ||
        typeof ownerValue !== "string" ||
        typeof pendingValue !== "string" ||
        typeof pausedValue !== "boolean"
    ) {
        throw new Error("DelegationManager operational identity mismatch");
    }
    const owner = getAddress(ownerValue);
    const pendingAddress = getAddress(pendingValue);
    const pendingOwner = pendingAddress === zeroAddress ? null : pendingAddress;
    if (owner !== expectedAdmin || pendingOwner !== null || pausedValue) {
        throw new Error("DelegationManager is not operationally active");
    }
    return {
        chainId,
        blockNumber: blockNumber.toString(),
        compositionId: FRAMEWORK_COMPOSITION_ID,
        delegationManager: manager,
        entryPoint,
        owner,
        pendingOwner,
        paused: pausedValue,
    };
}

function environmentAddress(
    environment: SmartAccountsEnvironment,
    name: FrameworkDeploymentName,
): Address | undefined {
    if (name === "DelegationManager") return getAddress(environment.DelegationManager);
    if (name === "SimpleFactory") return getAddress(environment.SimpleFactory);
    if (name === "SCL_RIP7212") return undefined;

    const implementations = environment.implementations as Record<string, Hex>;
    const implementation = implementations[name];
    if (implementation) return getAddress(implementation);

    const caveatEnforcers = environment.caveatEnforcers as Record<string, Hex>;
    const enforcer = caveatEnforcers[name];
    return enforcer ? getAddress(enforcer) : undefined;
}

function assertAddress(actualInput: string, expectedInput: string, field: string): void {
    const actual = getAddress(actualInput);
    const expected = getAddress(expectedInput);
    if (actual !== expected) throw new Error(`${field} mismatch`);
}

async function readFunction(
    publicClient: PublicClient,
    address: Address,
    abi: Abi,
    functionName: string,
    blockNumber: bigint,
): Promise<unknown> {
    return publicClient.readContract({
        address,
        abi,
        functionName,
        blockNumber,
    } as never);
}

async function verifyDomain(
    publicClient: PublicClient,
    address: Address,
    abi: Abi,
    expectedName: string,
    chainId: number,
    blockNumber: bigint,
): Promise<void> {
    const [name, version, domain] = await Promise.all([
        readFunction(publicClient, address, abi, "NAME", blockNumber),
        readFunction(publicClient, address, abi, "VERSION", blockNumber),
        readFunction(publicClient, address, abi, "eip712Domain", blockNumber),
    ]);
    if (name !== expectedName) throw new Error(`${expectedName} NAME mismatch`);
    if (version !== DELEGATION_FRAMEWORK_VERSION) {
        throw new Error(`${expectedName} VERSION mismatch`);
    }
    if (!Array.isArray(domain) || domain.length !== 7) {
        throw new Error(`${expectedName} EIP-712 domain is malformed`);
    }
    if (
        domain[1] !== expectedName ||
        domain[2] !== "1" ||
        domain[3] !== BigInt(chainId) ||
        typeof domain[4] !== "string" ||
        getAddress(domain[4]) !== address
    ) {
        throw new Error(`${expectedName} EIP-712 domain mismatch`);
    }
}

/**
 * Re-validates the public manifest, all code, SDK environment mappings,
 * constructor wiring getters, EIP-712 domains, and Framework admin state at
 * one fixed block.
 */
export async function verifyFrameworkLiveState(params: {
    publicClient: PublicClient;
    manifest: FrameworkDeploymentManifest;
    environment: SmartAccountsEnvironment;
    expectedAdmin: ExpectedFrameworkAdminState;
    blockNumber?: bigint;
}): Promise<FrameworkLiveVerification> {
    const chainId = await params.publicClient.getChainId();
    if (chainId !== params.manifest.chainId) {
        throw new Error("live chain does not match the Framework manifest");
    }
    if (
        params.manifest.compositionId !== FRAMEWORK_COMPOSITION_ID ||
        params.manifest.compositionSpecHash !== FRAMEWORK_COMPOSITION_SPEC_HASH ||
        params.manifest.deploymentCount !== FRAMEWORK_DEPLOYMENT_COUNT ||
        params.manifest.deployments.length !== FRAMEWORK_DEPLOYMENT_COUNT
    ) {
        throw new Error("Framework manifest composition identity mismatch");
    }

    const blockNumber =
        params.blockNumber ??
        (await params.publicClient.getBlockNumber({cacheTime: 0}));
    const manager = getAddress(params.environment.DelegationManager);
    const entryPoint = getAddress(params.environment.EntryPoint);
    assertAddress(params.manifest.entryPoint, entryPoint, "manifest EntryPoint");

    const seenAddresses = new Set<Address>();
    const recordsByName = new Map<FrameworkDeploymentName, Address>();
    for (const [index, name] of FRAMEWORK_DEPLOYMENT_ORDER.entries()) {
        const record = params.manifest.deployments[index];
        if (!record || record.index !== index || record.name !== name) {
            throw new Error(`Framework manifest deployment ${index} is missing or out of order`);
        }
        const address = getAddress(record.address);
        if (seenAddresses.has(address)) {
            throw new Error(`${name} reuses a Framework deployment address`);
        }
        seenAddresses.add(address);
        recordsByName.set(name, address);

        const expectedEnvironmentAddress = environmentAddress(params.environment, name);
        if (FRAMEWORK_COMPONENT_BY_NAME[name].hiddenFromEnvironment) {
            if (expectedEnvironmentAddress !== undefined) {
                throw new Error(`${name} must remain hidden from the SDK environment`);
            }
        } else if (!expectedEnvironmentAddress) {
            throw new Error(`${name} is missing from the SDK environment`);
        } else {
            assertAddress(address, expectedEnvironmentAddress, `${name} environment address`);
        }

        const code = await params.publicClient.getCode({address, blockNumber});
        if (!code || code === "0x") throw new Error(`${name} has no live runtime code`);
        const runtime = verifyFrameworkRuntimeCode(name, code);
        if (
            runtime.codeHash !== record.runtimeCodeHash ||
            runtime.normalizedCodeHash !== record.normalizedRuntimeCodeHash
        ) {
            throw new Error(`${name} live runtime differs from its deployment evidence`);
        }
        if (name === "SCL_RIP7212") verifySclRuntimeSelfAddress(code, address);
        const links = extractRuntimeLinkAddresses(name, code);
        if (
            links.length !== record.linkedLibraries.length ||
            links.some((link, linkIndex) => link !== record.linkedLibraries[linkIndex])
        ) {
            throw new Error(`${name} live library links differ from deployment evidence`);
        }
    }

    const scl = recordsByName.get("SCL_RIP7212");
    const hybrid = recordsByName.get("HybridDeleGatorImpl");
    if (!scl || !hybrid) throw new Error("Framework SCL or Hybrid record is missing");
    const hybridCode = await params.publicClient.getCode({address: hybrid, blockNumber});
    if (
        !hybridCode ||
        extractRuntimeLinkAddresses("HybridDeleGatorImpl", hybridCode)[0] !== scl
    ) {
        throw new Error("live HybridDeleGatorImpl SCL link mismatch");
    }

    const entryPointCode = await params.publicClient.getCode({address: entryPoint, blockNumber});
    if (!entryPointCode || entryPointCode === "0x") {
        throw new Error("live EntryPoint has no runtime code");
    }
    const entryPointCodeHash = keccak256(entryPointCode);
    if (entryPointCodeHash !== params.manifest.entryPointRuntimeCodeHash) {
        throw new Error("live EntryPoint differs from the deployment evidence");
    }
    if (chainId === 91_342) verifyGiwaEntryPointRuntimeCode(entryPointCode);

    const argsEquality = recordsByName.get("ArgsEqualityCheckEnforcer");
    const nativePayment = recordsByName.get("NativeTokenPaymentEnforcer");
    const multiSig = recordsByName.get("MultiSigDeleGatorImpl");
    const stateless = recordsByName.get("EIP7702StatelessDeleGatorImpl");
    if (!argsEquality || !nativePayment || !multiSig || !stateless) {
        throw new Error("Framework semantic wiring records are incomplete");
    }

    const [
        managerName,
        managerVersion,
        managerDomainVersion,
        ownerValue,
        pendingOwnerValue,
        pausedValue,
        nativeManager,
        nativeArgsEnforcer,
    ] = await Promise.all([
        readFunction(params.publicClient, manager, DelegationManagerAbi, "NAME", blockNumber),
        readFunction(params.publicClient, manager, DelegationManagerAbi, "VERSION", blockNumber),
        readFunction(
            params.publicClient,
            manager,
            DelegationManagerAbi,
            "DOMAIN_VERSION",
            blockNumber,
        ),
        readFunction(params.publicClient, manager, DelegationManagerAbi, "owner", blockNumber),
        readFunction(
            params.publicClient,
            manager,
            DelegationManagerAbi,
            "pendingOwner",
            blockNumber,
        ),
        readFunction(params.publicClient, manager, DelegationManagerAbi, "paused", blockNumber),
        readFunction(
            params.publicClient,
            nativePayment,
            NativeTokenPaymentEnforcerAbi,
            "delegationManager",
            blockNumber,
        ),
        readFunction(
            params.publicClient,
            nativePayment,
            NativeTokenPaymentEnforcerAbi,
            "argsEqualityCheckEnforcer",
            blockNumber,
        ),
    ]);
    if (
        managerName !== "DelegationManager" ||
        managerVersion !== DELEGATION_FRAMEWORK_VERSION ||
        managerDomainVersion !== "1"
    ) {
        throw new Error("DelegationManager identity mismatch");
    }
    if (
        typeof ownerValue !== "string" ||
        typeof pendingOwnerValue !== "string" ||
        typeof pausedValue !== "boolean" ||
        typeof nativeManager !== "string" ||
        typeof nativeArgsEnforcer !== "string"
    ) {
        throw new Error("Framework semantic getter returned an invalid value");
    }
    assertAddress(nativeManager, manager, "NativeTokenPaymentEnforcer manager");
    assertAddress(
        nativeArgsEnforcer,
        argsEquality,
        "NativeTokenPaymentEnforcer args enforcer",
    );

    const implementationChecks = [
        {
            address: hybrid,
            abi: HybridDeleGatorAbi,
            name: "HybridDeleGator",
        },
        {
            address: multiSig,
            abi: MultiSigDeleGatorAbi,
            name: "MultiSigDeleGator",
        },
        {
            address: stateless,
            abi: EIP7702StatelessDeleGatorAbi,
            name: "EIP7702StatelessDeleGator",
        },
    ] as const;
    await Promise.all(
        implementationChecks.map(async ({address, abi, name}) => {
            const [implementationManager, implementationEntryPoint, domainVersion] =
                await Promise.all([
                    readFunction(
                        params.publicClient,
                        address,
                        abi,
                        "delegationManager",
                        blockNumber,
                    ),
                    readFunction(
                        params.publicClient,
                        address,
                        abi,
                        "entryPoint",
                        blockNumber,
                    ),
                    readFunction(
                        params.publicClient,
                        address,
                        abi,
                        "DOMAIN_VERSION",
                        blockNumber,
                    ),
                ]);
            if (
                typeof implementationManager !== "string" ||
                typeof implementationEntryPoint !== "string" ||
                domainVersion !== "1"
            ) {
                throw new Error(`${name} semantic getter returned an invalid value`);
            }
            assertAddress(implementationManager, manager, `${name} manager`);
            assertAddress(implementationEntryPoint, entryPoint, `${name} EntryPoint`);
            await verifyDomain(
                params.publicClient,
                address,
                abi,
                name,
                chainId,
                blockNumber,
            );
        }),
    );
    await verifyDomain(
        params.publicClient,
        manager,
        DelegationManagerAbi,
        "DelegationManager",
        chainId,
        blockNumber,
    );

    const owner = getAddress(ownerValue);
    const pendingOwnerAddress = getAddress(pendingOwnerValue);
    const pendingOwner = pendingOwnerAddress === zeroAddress ? null : pendingOwnerAddress;
    assertAddress(owner, params.expectedAdmin.owner, "DelegationManager owner");
    const expectedPending = params.expectedAdmin.pendingOwner
        ? getAddress(params.expectedAdmin.pendingOwner)
        : null;
    if (pendingOwner !== expectedPending) {
        throw new Error("DelegationManager pending owner mismatch");
    }
    if (pausedValue !== params.expectedAdmin.paused) {
        throw new Error("DelegationManager pause state mismatch");
    }

    return {
        chainId,
        blockNumber: blockNumber.toString(),
        compositionId: FRAMEWORK_COMPOSITION_ID,
        delegationManager: manager,
        entryPoint,
        owner,
        pendingOwner,
        paused: pausedValue,
    };
}

/**
 * Verifies the deployed owner HybridDeleGator proxy through both the ERC-1967
 * slot and the account's public getters.
 */
export async function verifyOwnerSmartAccount(params: {
    publicClient: PublicClient;
    account: Address;
    expectedOwner: Address;
    environment: SmartAccountsEnvironment;
    blockNumber?: bigint;
}): Promise<OwnerAccountVerification> {
    const chainId = await params.publicClient.getChainId();
    const blockNumber =
        params.blockNumber ??
        (await params.publicClient.getBlockNumber({cacheTime: 0}));
    const account = getAddress(params.account);
    const hybridImplementation = params.environment.implementations.HybridDeleGatorImpl;
    if (!hybridImplementation) {
        throw new Error("owner smart account Hybrid implementation is missing");
    }
    const expectedImplementation = getAddress(hybridImplementation);
    const expectedManager = getAddress(params.environment.DelegationManager);
    const expectedEntryPoint = getAddress(params.environment.EntryPoint);
    const code = await params.publicClient.getCode({address: account, blockNumber});
    if (!code || code === "0x") throw new Error("owner smart account has no runtime code");
    const runtimeCodeHash = keccak256(code);
    if (runtimeCodeHash !== OWNER_ACCOUNT_PROXY_RUNTIME_CODE_HASH) {
        throw new Error("owner smart account proxy runtime mismatch");
    }

    const storageValue = await params.publicClient.getStorageAt({
        address: account,
        slot: EIP1967_IMPLEMENTATION_SLOT,
        blockNumber,
    });
    if (!storageValue || storageValue.length !== 66) {
        throw new Error("owner smart account ERC-1967 implementation slot is empty");
    }
    const slotImplementation = getAddress(`0x${storageValue.slice(-40)}`);
    assertAddress(
        slotImplementation,
        expectedImplementation,
        "owner smart account ERC-1967 implementation",
    );

    const [
        getterImplementation,
        ownerValue,
        managerValue,
        entryPointValue,
        initializedVersion,
        p256KeyCount,
    ] = await Promise.all([
        readFunction(
            params.publicClient,
            account,
            HybridDeleGatorAbi,
            "getImplementation",
            blockNumber,
        ),
        readFunction(params.publicClient, account, HybridDeleGatorAbi, "owner", blockNumber),
        readFunction(
            params.publicClient,
            account,
            HybridDeleGatorAbi,
            "delegationManager",
            blockNumber,
        ),
        readFunction(
            params.publicClient,
            account,
            HybridDeleGatorAbi,
            "entryPoint",
            blockNumber,
        ),
        readFunction(
            params.publicClient,
            account,
            HybridDeleGatorAbi,
            "getInitializedVersion",
            blockNumber,
        ),
        readFunction(
            params.publicClient,
            account,
            HybridDeleGatorAbi,
            "getKeyIdHashesCount",
            blockNumber,
        ),
    ]);
    if (
        typeof getterImplementation !== "string" ||
        typeof ownerValue !== "string" ||
        typeof managerValue !== "string" ||
        typeof entryPointValue !== "string" ||
        typeof initializedVersion !== "bigint" ||
        typeof p256KeyCount !== "bigint"
    ) {
        throw new Error("owner smart account getter returned an invalid value");
    }
    assertAddress(
        getterImplementation,
        expectedImplementation,
        "owner smart account implementation getter",
    );
    assertAddress(ownerValue, params.expectedOwner, "owner smart account owner");
    assertAddress(managerValue, expectedManager, "owner smart account manager");
    assertAddress(entryPointValue, expectedEntryPoint, "owner smart account EntryPoint");
    if (initializedVersion !== 1n) {
        throw new Error("owner smart account initialized version mismatch");
    }
    if (p256KeyCount !== 0n) {
        throw new Error("owner smart account has unexpected P-256 keys");
    }

    return {
        chainId,
        blockNumber: blockNumber.toString(),
        account,
        owner: getAddress(ownerValue),
        implementation: getAddress(getterImplementation),
        delegationManager: getAddress(managerValue),
        entryPoint: getAddress(entryPointValue),
        initializedVersion: initializedVersion.toString(),
        p256KeyCount: p256KeyCount.toString(),
        runtimeCodeHash,
    };
}
