import {
    decodeAbiParameters,
    encodeDeployData,
    encodeAbiParameters,
    getAddress,
    isAddress,
    isHex,
    keccak256,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import {
    FRAMEWORK_COMPONENT_BY_NAME,
    FRAMEWORK_COMPOSITION_ID,
    FRAMEWORK_COMPOSITION_SPEC_HASH,
    FRAMEWORK_DEPLOYMENT_COUNT,
    FRAMEWORK_DEPLOYMENT_ORDER,
    GIWA_ENTRY_POINT_V07_IDENTITY,
    extractRuntimeLinkAddresses,
    frameworkCreationBytecodeTemplate,
    identifyFrameworkDeploymentBytecode,
    normalizedCreationCodeHash,
    verifyFrameworkRuntimeCode,
    verifySclRuntimeSelfAddress,
    type FrameworkDeploymentName,
} from "./composition.js";

type WalletDeployParameters = Parameters<WalletClient["deployContract"]>[0];

interface PendingDeploymentRecord {
    index: number;
    name: FrameworkDeploymentName;
    transactionHash: Hex;
    deploymentData: Hex;
    constructorArguments: readonly unknown[];
    creationCodeHash: Hex;
}

export interface FrameworkDeploymentRecord {
    index: number;
    name: FrameworkDeploymentName;
    address: Address;
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    transactionIndex: number;
    nonce: string;
    gasUsed: string;
    deploymentDataHash: Hex;
    creationCodeHash: Hex;
    constructorArguments: readonly string[];
    runtimeCodeHash: Hex;
    normalizedRuntimeCodeHash: Hex;
    linkedLibraries: readonly Address[];
}

export interface FrameworkDeploymentManifest {
    schemaVersion: 1;
    compositionId: typeof FRAMEWORK_COMPOSITION_ID;
    compositionSpecHash: typeof FRAMEWORK_COMPOSITION_SPEC_HASH;
    chainId: number;
    deployer: Address;
    entryPoint: Address;
    entryPointRuntimeCodeHash: Hex;
    verificationBlock: string;
    deploymentCount: typeof FRAMEWORK_DEPLOYMENT_COUNT;
    deployments: readonly FrameworkDeploymentRecord[];
}

function parsedHash(value: unknown, field: string): Hex {
    if (
        typeof value !== "string" ||
        !isHex(value, {strict: true}) ||
        value.length !== 66
    ) {
        throw new Error(`${field} must be a 32-byte hex value`);
    }
    return value;
}

function parsedAddress(value: unknown, field: string): Address {
    if (typeof value !== "string" || !isAddress(value)) {
        throw new Error(`${field} must be an address`);
    }
    return getAddress(value);
}

function parsedDecimal(value: unknown, field: string): string {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
        throw new Error(`${field} must be a decimal integer`);
    }
    return value;
}

function parsedIndex(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
    return value;
}

/** Parse a public evidence manifest before using it as a live-verification input. */
export function parseFrameworkDeploymentManifest(
    input: unknown,
): FrameworkDeploymentManifest {
    if (!input || typeof input !== "object") {
        throw new Error("Framework manifest must be an object");
    }
    const value = input as Record<string, unknown>;
    if (value.schemaVersion !== 1) throw new Error("Framework manifest schemaVersion must be 1");
    if (value.compositionId !== FRAMEWORK_COMPOSITION_ID) {
        throw new Error("Framework manifest composition ID mismatch");
    }
    if (value.compositionSpecHash !== FRAMEWORK_COMPOSITION_SPEC_HASH) {
        throw new Error("Framework manifest composition spec hash mismatch");
    }
    if (
        typeof value.chainId !== "number" ||
        !Number.isSafeInteger(value.chainId) ||
        value.chainId < 1
    ) {
        throw new Error("Framework manifest chainId is invalid");
    }
    const deployer = parsedAddress(value.deployer, "Framework manifest deployer");
    const entryPoint = parsedAddress(value.entryPoint, "Framework manifest EntryPoint");
    const entryPointRuntimeCodeHash = parsedHash(
        value.entryPointRuntimeCodeHash,
        "Framework manifest EntryPoint runtime hash",
    );
    if (
        value.chainId === 91_342 &&
        (entryPoint !== GIWA_ENTRY_POINT_V07_IDENTITY.address ||
            entryPointRuntimeCodeHash !== GIWA_ENTRY_POINT_V07_IDENTITY.runtimeCodeHash)
    ) {
        throw new Error("Framework manifest GIWA EntryPoint identity mismatch");
    }
    const verificationBlock = parsedDecimal(
        value.verificationBlock,
        "Framework manifest verificationBlock",
    );
    if (value.deploymentCount !== FRAMEWORK_DEPLOYMENT_COUNT) {
        throw new Error(`Framework manifest must contain ${FRAMEWORK_DEPLOYMENT_COUNT} units`);
    }
    if (
        !Array.isArray(value.deployments) ||
        value.deployments.length !== FRAMEWORK_DEPLOYMENT_COUNT
    ) {
        throw new Error(`Framework manifest must have ${FRAMEWORK_DEPLOYMENT_COUNT} records`);
    }

    const seenAddresses = new Set<Address>();
    const seenTransactions = new Set<Hex>();
    const deployments: FrameworkDeploymentRecord[] = [];
    for (const [index, name] of FRAMEWORK_DEPLOYMENT_ORDER.entries()) {
        const raw = value.deployments[index];
        if (!raw || typeof raw !== "object") {
            throw new Error(`Framework manifest deployment ${index} must be an object`);
        }
        const record = raw as Record<string, unknown>;
        if (record.index !== index || record.name !== name) {
            throw new Error(`Framework manifest deployment ${index} is out of order`);
        }
        const address = parsedAddress(record.address, `${name}.address`);
        const transactionHash = parsedHash(record.transactionHash, `${name}.transactionHash`);
        if (seenAddresses.has(address)) throw new Error(`${name} address is duplicated`);
        if (seenTransactions.has(transactionHash)) {
            throw new Error(`${name} transaction hash is duplicated`);
        }
        seenAddresses.add(address);
        seenTransactions.add(transactionHash);

        const creationCodeHash = parsedHash(
            record.creationCodeHash,
            `${name}.creationCodeHash`,
        );
        if (
            creationCodeHash !==
            FRAMEWORK_COMPONENT_BY_NAME[name].normalizedCreationCodeHash
        ) {
            throw new Error(`${name} creation code hash mismatch`);
        }
        const normalizedRuntimeCodeHash = parsedHash(
            record.normalizedRuntimeCodeHash,
            `${name}.normalizedRuntimeCodeHash`,
        );
        const runtimeSpec = FRAMEWORK_COMPONENT_BY_NAME[name].runtime;
        const expectedNormalizedRuntime =
            runtimeSpec.kind === "exact"
                ? runtimeSpec.codeHash
                : runtimeSpec.normalizedCodeHash;
        if (normalizedRuntimeCodeHash !== expectedNormalizedRuntime) {
            throw new Error(`${name} normalized runtime hash mismatch`);
        }
        if (!Array.isArray(record.constructorArguments)) {
            throw new Error(`${name}.constructorArguments must be an array`);
        }
        const constructorArguments = record.constructorArguments.map((argument) => {
            if (typeof argument !== "string") {
                throw new Error(`${name} constructor argument must be a string`);
            }
            return isAddress(argument) ? getAddress(argument) : argument;
        });
        if (!Array.isArray(record.linkedLibraries)) {
            throw new Error(`${name}.linkedLibraries must be an array`);
        }
        const linkedLibraries = record.linkedLibraries.map((link, linkIndex) =>
            parsedAddress(link, `${name}.linkedLibraries[${linkIndex}]`),
        );
        if (
            (name === "HybridDeleGatorImpl" && linkedLibraries.length !== 1) ||
            (name !== "HybridDeleGatorImpl" && linkedLibraries.length !== 0)
        ) {
            throw new Error(`${name} linked library count mismatch`);
        }

        const runtimeCodeHash = parsedHash(
            record.runtimeCodeHash,
            `${name}.runtimeCodeHash`,
        );
        if (runtimeSpec.kind === "exact" && runtimeCodeHash !== runtimeSpec.codeHash) {
            throw new Error(`${name} exact runtime hash mismatch`);
        }
        deployments.push({
            index: parsedIndex(record.index, `${name}.index`),
            name,
            address,
            transactionHash,
            blockNumber: parsedDecimal(record.blockNumber, `${name}.blockNumber`),
            blockHash: parsedHash(record.blockHash, `${name}.blockHash`),
            transactionIndex: parsedIndex(
                record.transactionIndex,
                `${name}.transactionIndex`,
            ),
            nonce: parsedDecimal(record.nonce, `${name}.nonce`),
            gasUsed: parsedDecimal(record.gasUsed, `${name}.gasUsed`),
            deploymentDataHash: parsedHash(
                record.deploymentDataHash,
                `${name}.deploymentDataHash`,
            ),
            creationCodeHash,
            constructorArguments,
            runtimeCodeHash,
            normalizedRuntimeCodeHash,
            linkedLibraries,
        });
    }

    const scl = deployments[FRAMEWORK_DEPLOYMENT_ORDER.indexOf("SCL_RIP7212")];
    const hybrid =
        deployments[FRAMEWORK_DEPLOYMENT_ORDER.indexOf("HybridDeleGatorImpl")];
    if (!scl || !hybrid || hybrid.linkedLibraries[0] !== scl.address) {
        throw new Error("Framework manifest Hybrid SCL link mismatch");
    }
    const byName = Object.fromEntries(
        deployments.map((record) => [record.name, record]),
    ) as Record<FrameworkDeploymentName, FrameworkDeploymentRecord>;
    const expectedArguments: Partial<
        Record<FrameworkDeploymentName, readonly Address[]>
    > = {
        DelegationManager: [deployer],
        NativeTokenPaymentEnforcer: [
            byName.DelegationManager.address,
            byName.ArgsEqualityCheckEnforcer.address,
        ],
        HybridDeleGatorImpl: [byName.DelegationManager.address, entryPoint],
        MultiSigDeleGatorImpl: [byName.DelegationManager.address, entryPoint],
        EIP7702StatelessDeleGatorImpl: [
            byName.DelegationManager.address,
            entryPoint,
        ],
    };
    const firstNonce = BigInt(deployments[0]?.nonce ?? "0");
    for (const [index, record] of deployments.entries()) {
        const expected = expectedArguments[record.name] ?? [];
        if (
            record.constructorArguments.length !== expected.length ||
            expected.some(
                (argument, argumentIndex) =>
                    record.constructorArguments[argumentIndex] !== argument,
            )
        ) {
            throw new Error(`${record.name} constructor wiring mismatch`);
        }
        if (BigInt(record.nonce) !== firstNonce + BigInt(index)) {
            throw new Error(`${record.name} nonce sequence mismatch`);
        }
    }
    const lastDeploymentBlock = BigInt(
        deployments[deployments.length - 1]?.blockNumber ?? "0",
    );
    if (BigInt(verificationBlock) < lastDeploymentBlock) {
        throw new Error("Framework manifest verification block predates deployment");
    }

    return {
        schemaVersion: 1,
        compositionId: FRAMEWORK_COMPOSITION_ID,
        compositionSpecHash: FRAMEWORK_COMPOSITION_SPEC_HASH,
        chainId: value.chainId,
        deployer,
        entryPoint,
        entryPointRuntimeCodeHash,
        verificationBlock,
        deploymentCount: FRAMEWORK_DEPLOYMENT_COUNT,
        deployments,
    };
}

export function parseFrameworkDeploymentManifestJson(
    json: string,
): FrameworkDeploymentManifest {
    let value: unknown;
    try {
        value = JSON.parse(json);
    } catch {
        throw new Error("Framework manifest is not valid JSON");
    }
    return parseFrameworkDeploymentManifest(value);
}

function deploymentData(parameters: WalletDeployParameters): Hex {
    const args = "args" in parameters ? parameters.args : undefined;
    return encodeDeployData({
        abi: parameters.abi,
        bytecode: parameters.bytecode,
        ...(args === undefined ? {} : {args}),
    } as Parameters<typeof encodeDeployData>[0]);
}

function constructorArguments(parameters: WalletDeployParameters): readonly unknown[] {
    return "args" in parameters && Array.isArray(parameters.args)
        ? [...parameters.args]
        : [];
}

/**
 * Records the exact SDK deployment calls before they are broadcast.
 *
 * Component identity and order are checked before calling the underlying
 * wallet, so unknown bytecode cannot be sent as part of an approved Framework
 * bootstrap.
 */
export class FrameworkDeploymentRecorder {
    readonly #records: PendingDeploymentRecord[] = [];

    async deploy(
        parameters: WalletDeployParameters,
        submit: (parameters: WalletDeployParameters) => Promise<Hex>,
    ): Promise<Hex> {
        const name = identifyFrameworkDeploymentBytecode(parameters.bytecode);
        const index = this.#records.length;
        const expected = FRAMEWORK_DEPLOYMENT_ORDER[index];
        if (!expected) {
            throw new Error(`Framework deployment exceeds ${FRAMEWORK_DEPLOYMENT_COUNT} units`);
        }
        if (name !== expected) {
            throw new Error(
                `Framework deployment order mismatch at ${index}: expected ${expected}, received ${name}`,
            );
        }

        const data = deploymentData(parameters);
        const hash = await submit(parameters);
        this.#records.push({
            index,
            name,
            transactionHash: hash,
            deploymentData: data,
            constructorArguments: constructorArguments(parameters),
            creationCodeHash: normalizedCreationCodeHash(
                FRAMEWORK_COMPONENT_BY_NAME[name],
                parameters.bytecode,
            ),
        });
        return hash;
    }

    /**
     * Imports a contract-creation transaction produced by the pinned Forge script.
     *
     * Forge deploys the exact npm creation code directly, so the transaction input
     * can be split at the pinned template length. Constructor data is decoded and
     * re-encoded canonically before it enters the same RPC finalizer used by the SDK.
     */
    recordExternalDeployment(transactionHash: Hex, deploymentData: Hex): void {
        const index = this.#records.length;
        const expected = FRAMEWORK_DEPLOYMENT_ORDER[index];
        if (!expected) {
            throw new Error(`Framework deployment exceeds ${FRAMEWORK_DEPLOYMENT_COUNT} units`);
        }
        const template = frameworkCreationBytecodeTemplate(expected);
        if (
            !isHex(deploymentData, {strict: true}) ||
            deploymentData.length < template.length
        ) {
            throw new Error(`${expected} external deployment data is truncated`);
        }
        const bytecode = deploymentData.slice(0, template.length);
        const name = identifyFrameworkDeploymentBytecode(bytecode);
        if (name !== expected) {
            throw new Error(
                `Framework deployment order mismatch at ${index}: expected ${expected}, received ${name}`,
            );
        }

        const encodedArguments = `0x${deploymentData.slice(template.length)}` as Hex;
        const parameterCount =
            expected === "DelegationManager"
                ? 1
                : [
                        "NativeTokenPaymentEnforcer",
                        "HybridDeleGatorImpl",
                        "MultiSigDeleGatorImpl",
                        "EIP7702StatelessDeleGatorImpl",
                    ].includes(expected)
                  ? 2
                  : 0;
        let decodedArguments: readonly unknown[] = [];
        if (parameterCount === 0) {
            if (encodedArguments !== "0x") {
                throw new Error(`${expected} must not have external constructor data`);
            }
        } else {
            const parameters = Array.from({length: parameterCount}, () => ({
                type: "address" as const,
            }));
            decodedArguments = decodeAbiParameters(parameters, encodedArguments);
            if (
                encodeAbiParameters(
                    parameters,
                    decodedArguments as readonly Address[],
                ) !== encodedArguments
            ) {
                throw new Error(`${expected} external constructor data is not canonical`);
            }
        }

        this.#records.push({
            index,
            name,
            transactionHash,
            deploymentData,
            constructorArguments: decodedArguments,
            creationCodeHash: normalizedCreationCodeHash(
                FRAMEWORK_COMPONENT_BY_NAME[name],
                bytecode,
            ),
        });
    }

    assertComplete(): void {
        if (this.#records.length !== FRAMEWORK_DEPLOYMENT_COUNT) {
            throw new Error(
                `Framework deployment incomplete: expected ${FRAMEWORK_DEPLOYMENT_COUNT}, recorded ${this.#records.length}`,
            );
        }
        for (const [index, expected] of FRAMEWORK_DEPLOYMENT_ORDER.entries()) {
            if (this.#records[index]?.name !== expected) {
                throw new Error(`Framework deployment record ${index} is missing or out of order`);
            }
        }
    }

    pendingRecords(): readonly PendingDeploymentRecord[] {
        return this.#records.map((record) => ({
            ...record,
            constructorArguments: [...record.constructorArguments],
        }));
    }
}

export function createRecordingWalletClient<T extends WalletClient>(
    walletClient: T,
    recorder: FrameworkDeploymentRecorder,
): T {
    const deploy = walletClient.deployContract.bind(walletClient) as (
        parameters: WalletDeployParameters,
    ) => Promise<Hex>;
    return new Proxy(walletClient, {
        get(target, property, receiver) {
            if (property === "deployContract") {
                return (parameters: WalletDeployParameters) =>
                    recorder.deploy(parameters, deploy);
            }
            return Reflect.get(target, property, receiver) as unknown;
        },
    });
}

function serializeConstructorArgument(value: unknown, name: FrameworkDeploymentName): string {
    if (typeof value === "string") {
        return isAddress(value) ? getAddress(value) : value;
    }
    if (typeof value === "bigint" || typeof value === "number") return String(value);
    if (typeof value === "boolean") return String(value);
    throw new Error(`${name} has an unsupported constructor argument`);
}

function assertAddressArguments(
    record: PendingDeploymentRecord,
    expected: readonly Address[],
): void {
    if (record.constructorArguments.length !== expected.length) {
        throw new Error(`${record.name} constructor argument count mismatch`);
    }
    for (const [index, expectedAddress] of expected.entries()) {
        const actual = record.constructorArguments[index];
        if (typeof actual !== "string" || !isAddress(actual)) {
            throw new Error(`${record.name} constructor argument ${index} is not an address`);
        }
        if (getAddress(actual) !== expectedAddress) {
            throw new Error(`${record.name} constructor argument ${index} mismatch`);
        }
    }
}

function assertConstructorWiring(
    records: readonly PendingDeploymentRecord[],
    addresses: Readonly<Record<FrameworkDeploymentName, Address>>,
    deployer: Address,
    entryPoint: Address,
): void {
    const noArgumentNames = FRAMEWORK_DEPLOYMENT_ORDER.filter(
        (name) =>
            ![
                "DelegationManager",
                "NativeTokenPaymentEnforcer",
                "HybridDeleGatorImpl",
                "MultiSigDeleGatorImpl",
                "EIP7702StatelessDeleGatorImpl",
            ].includes(name),
    );
    for (const name of noArgumentNames) {
        const record = records.find((candidate) => candidate.name === name);
        if (!record || record.constructorArguments.length !== 0) {
            throw new Error(`${name} must not have constructor arguments`);
        }
    }

    const byName = Object.fromEntries(records.map((record) => [record.name, record])) as Record<
        FrameworkDeploymentName,
        PendingDeploymentRecord
    >;
    assertAddressArguments(byName.DelegationManager, [deployer]);
    assertAddressArguments(byName.NativeTokenPaymentEnforcer, [
        addresses.DelegationManager,
        addresses.ArgsEqualityCheckEnforcer,
    ]);
    for (const name of [
        "HybridDeleGatorImpl",
        "MultiSigDeleGatorImpl",
        "EIP7702StatelessDeleGatorImpl",
    ] as const) {
        assertAddressArguments(byName[name], [addresses.DelegationManager, entryPoint]);
    }
}

/**
 * Re-reads every transaction, receipt, and runtime from RPC and emits a public
 * evidence manifest. The GIWA EntryPoint identity is verified separately
 * because local Anvil tests use the SDK-bundled EntryPoint.
 */
export async function finalizeFrameworkDeploymentManifest(
    recorder: FrameworkDeploymentRecorder,
    publicClient: PublicClient,
    namedDeployments: Readonly<Record<string, Hex>>,
    deployerInput: Address,
): Promise<FrameworkDeploymentManifest> {
    recorder.assertComplete();
    const deployer = getAddress(deployerInput);
    const entryPointValue = namedDeployments.EntryPoint;
    if (!entryPointValue || !isAddress(entryPointValue)) {
        throw new Error("named Framework deployments must include EntryPoint");
    }
    const entryPoint = getAddress(entryPointValue);
    const pending = recorder.pendingRecords();

    const records: FrameworkDeploymentRecord[] = [];
    const addresses = {} as Record<FrameworkDeploymentName, Address>;
    const seenTransactionHashes = new Set<Hex>();
    let firstNonce: number | undefined;
    for (const record of pending) {
        if (seenTransactionHashes.has(record.transactionHash)) {
            throw new Error(`${record.name} reuses an earlier deployment transaction`);
        }
        seenTransactionHashes.add(record.transactionHash);
        const [transaction, receipt] = await Promise.all([
            publicClient.getTransaction({hash: record.transactionHash}),
            publicClient.getTransactionReceipt({hash: record.transactionHash}),
        ]);
        if (receipt.status !== "success") {
            throw new Error(`${record.name} deployment reverted`);
        }
        if (transaction.to !== null) {
            throw new Error(`${record.name} deployment transaction has a target`);
        }
        if (getAddress(transaction.from) !== deployer) {
            throw new Error(`${record.name} deployment sender mismatch`);
        }
        firstNonce ??= transaction.nonce;
        if (transaction.nonce !== firstNonce + record.index) {
            throw new Error(`${record.name} deployment nonce is not contiguous`);
        }
        if (transaction.input !== record.deploymentData) {
            throw new Error(`${record.name} deployment input mismatch`);
        }
        if (!receipt.contractAddress) {
            throw new Error(`${record.name} receipt has no contract address`);
        }
        const address = getAddress(receipt.contractAddress);
        const namedAddress = namedDeployments[record.name];
        if (
            record.name !== "SCL_RIP7212" &&
            (!namedAddress ||
                !isAddress(namedAddress) ||
                getAddress(namedAddress) !== address)
        ) {
            throw new Error(`${record.name} named deployment address mismatch`);
        }

        const code = await publicClient.getCode({
            address,
            blockNumber: receipt.blockNumber,
        });
        if (!code) throw new Error(`${record.name} runtime could not be read`);
        const runtime = verifyFrameworkRuntimeCode(record.name, code);
        if (record.name === "SCL_RIP7212") {
            verifySclRuntimeSelfAddress(code, address);
        }
        const linkedLibraries = extractRuntimeLinkAddresses(record.name, code);
        addresses[record.name] = address;
        records.push({
            index: record.index,
            name: record.name,
            address,
            transactionHash: record.transactionHash,
            blockNumber: receipt.blockNumber.toString(),
            blockHash: receipt.blockHash,
            transactionIndex: receipt.transactionIndex,
            nonce: transaction.nonce.toString(),
            gasUsed: receipt.gasUsed.toString(),
            deploymentDataHash: keccak256(record.deploymentData),
            creationCodeHash: record.creationCodeHash,
            constructorArguments: record.constructorArguments.map((argument) =>
                serializeConstructorArgument(argument, record.name),
            ),
            runtimeCodeHash: runtime.codeHash,
            normalizedRuntimeCodeHash: runtime.normalizedCodeHash,
            linkedLibraries,
        });
    }

    assertConstructorWiring(pending, addresses, deployer, entryPoint);
    const hybrid = records.find((record) => record.name === "HybridDeleGatorImpl");
    const scl = addresses.SCL_RIP7212;
    if (
        !hybrid ||
        hybrid.linkedLibraries.length !== 1 ||
        hybrid.linkedLibraries[0] !== scl
    ) {
        throw new Error("HybridDeleGatorImpl is not linked to the recorded SCL_RIP7212");
    }

    const verificationBlock = await publicClient.getBlockNumber({cacheTime: 0});
    const entryPointCode = await publicClient.getCode({
        address: entryPoint,
        blockNumber: verificationBlock,
    });
    if (!entryPointCode || entryPointCode === "0x") {
        throw new Error("recorded EntryPoint has no runtime code");
    }

    return {
        schemaVersion: 1,
        compositionId: FRAMEWORK_COMPOSITION_ID,
        compositionSpecHash: FRAMEWORK_COMPOSITION_SPEC_HASH,
        chainId: await publicClient.getChainId(),
        deployer,
        entryPoint,
        entryPointRuntimeCodeHash: keccak256(entryPointCode),
        verificationBlock: verificationBlock.toString(),
        deploymentCount: FRAMEWORK_DEPLOYMENT_COUNT,
        deployments: records,
    };
}
