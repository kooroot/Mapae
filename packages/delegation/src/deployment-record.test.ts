import {describe, expect, test} from "bun:test";
import * as DelegationAbis from "@metamask/delegation-abis";
import * as DelegationBytecodes from "@metamask/delegation-abis/bytecode";
import {encodeDeployData, getAddress, type Address, type Hex} from "viem";
import {
    FRAMEWORK_COMPONENT_BY_NAME,
    FRAMEWORK_COMPOSITION_ID,
    FRAMEWORK_COMPOSITION_SPEC_HASH,
    FRAMEWORK_DEPLOYMENT_COUNT,
    FRAMEWORK_DEPLOYMENT_ORDER,
    GIWA_ENTRY_POINT_V07_IDENTITY,
    type FrameworkDeploymentName,
} from "./composition.js";
import {
    FrameworkDeploymentRecorder,
    parseFrameworkDeploymentManifest,
} from "./deployment-record.js";

const DEPLOYER = getAddress("0x1000000000000000000000000000000000000001");
const MANAGER = getAddress("0x1000000000000000000000000000000000000002");
const ARGS_ENFORCER = getAddress("0x1000000000000000000000000000000000000003");
const ENTRY_POINT = getAddress("0x1000000000000000000000000000000000000004");
const SCL = getAddress("0x1000000000000000000000000000000000000005");

function exportName(name: FrameworkDeploymentName): string {
    return name.endsWith("Impl") ? name.slice(0, -"Impl".length) : name;
}

function deploymentParameters(name: FrameworkDeploymentName) {
    const key = exportName(name);
    const abi = (DelegationAbis as unknown as Record<string, unknown>)[key];
    const rawBytecode = (DelegationBytecodes as unknown as Record<string, unknown>)[key];
    if (!Array.isArray(abi) || typeof rawBytecode !== "string") {
        throw new Error(`missing official deployment fixture for ${name}`);
    }
    const bytecode =
        name === "HybridDeleGatorImpl"
            ? rawBytecode.replace(
                  /__\$b8f96b288d4d0429e38b8ed50fd423070f\$__/gu,
                  SCL.slice(2),
              )
            : rawBytecode;
    const args =
        name === "DelegationManager"
            ? [DEPLOYER]
            : name === "NativeTokenPaymentEnforcer"
              ? [MANAGER, ARGS_ENFORCER]
              : name.endsWith("Impl")
                ? [MANAGER, ENTRY_POINT]
                : [];
    return {abi, bytecode, args};
}

function transactionHash(index: number): Hex {
    return `0x${(index + 1).toString(16).padStart(64, "0")}`;
}

function manifestFixture() {
    const addresses = FRAMEWORK_DEPLOYMENT_ORDER.map((_, index) =>
        getAddress(`0x${(index + 100).toString(16).padStart(40, "0")}`),
    );
    const addressByName = Object.fromEntries(
        FRAMEWORK_DEPLOYMENT_ORDER.map((name, index) => [name, addresses[index]!]),
    ) as Record<FrameworkDeploymentName, Address>;
    const sclAddress = addresses[FRAMEWORK_DEPLOYMENT_ORDER.indexOf("SCL_RIP7212")]!;
    return {
        schemaVersion: 1,
        compositionId: FRAMEWORK_COMPOSITION_ID,
        compositionSpecHash: FRAMEWORK_COMPOSITION_SPEC_HASH,
        chainId: 91_342,
        deployer: DEPLOYER,
        entryPoint: GIWA_ENTRY_POINT_V07_IDENTITY.address,
        entryPointRuntimeCodeHash: GIWA_ENTRY_POINT_V07_IDENTITY.runtimeCodeHash,
        verificationBlock: "200",
        deploymentCount: FRAMEWORK_DEPLOYMENT_COUNT,
        deployments: FRAMEWORK_DEPLOYMENT_ORDER.map((name, index) => {
            const runtime = FRAMEWORK_COMPONENT_BY_NAME[name].runtime;
            const normalizedRuntimeCodeHash =
                runtime.kind === "exact" ? runtime.codeHash : runtime.normalizedCodeHash;
            return {
                index,
                name,
                address: addresses[index],
                transactionHash: transactionHash(index),
                blockNumber: String(index + 1),
                blockHash: `0x${(index + 200).toString(16).padStart(64, "0")}`,
                transactionIndex: 0,
                nonce: String(index),
                gasUsed: "100000",
                deploymentDataHash: `0x${(index + 300).toString(16).padStart(64, "0")}`,
                creationCodeHash:
                    FRAMEWORK_COMPONENT_BY_NAME[name].normalizedCreationCodeHash,
                constructorArguments:
                    name === "DelegationManager"
                        ? [DEPLOYER]
                        : name === "NativeTokenPaymentEnforcer"
                          ? [
                                addressByName.DelegationManager,
                                addressByName.ArgsEqualityCheckEnforcer,
                            ]
                          : name.endsWith("Impl")
                            ? [addressByName.DelegationManager, GIWA_ENTRY_POINT_V07_IDENTITY.address]
                            : [],
                runtimeCodeHash: normalizedRuntimeCodeHash,
                normalizedRuntimeCodeHash,
                linkedLibraries:
                    name === "HybridDeleGatorImpl" ? [sclAddress] : [],
            };
        }),
    };
}

describe("Framework deployment recorder", () => {
    test("captures the exact pinned order and refuses incomplete evidence", async () => {
        const recorder = new FrameworkDeploymentRecorder();
        expect(() => recorder.assertComplete()).toThrow("incomplete");

        for (const [index, name] of FRAMEWORK_DEPLOYMENT_ORDER.entries()) {
            const expectedHash = transactionHash(index);
            const actualHash = await recorder.deploy(
                deploymentParameters(name) as never,
                async () => expectedHash,
            );
            expect(actualHash).toBe(expectedHash);
        }

        expect(() => recorder.assertComplete()).not.toThrow();
        const records = recorder.pendingRecords();
        expect(records).toHaveLength(FRAMEWORK_DEPLOYMENT_COUNT);
        expect(records.map(({name}) => name)).toEqual([...FRAMEWORK_DEPLOYMENT_ORDER]);
        expect(records[34]?.name).toBe("SCL_RIP7212");
        expect(records[35]?.name).toBe("HybridDeleGatorImpl");
    });

    test("blocks changed order before submitting a transaction", async () => {
        const recorder = new FrameworkDeploymentRecorder();
        let submitted = false;
        await expect(
            recorder.deploy(deploymentParameters("AllowedCalldataEnforcer") as never, async () => {
                submitted = true;
                return transactionHash(0);
            }),
        ).rejects.toThrow("expected SimpleFactory");
        expect(submitted).toBeFalse();
        expect(recorder.pendingRecords()).toHaveLength(0);
    });

    test("blocks bytecode outside the pinned composition before submit", async () => {
        const recorder = new FrameworkDeploymentRecorder();
        let submitted = false;
        await expect(
            recorder.deploy(
                {abi: [], bytecode: "0x60006000", args: []} as never,
                async () => {
                    submitted = true;
                    return transactionHash(0);
                },
            ),
        ).rejects.toThrow("not in the pinned Framework composition");
        expect(submitted).toBeFalse();
    });

    test("imports the exact Forge creation inputs into the same evidence path", () => {
        const recorder = new FrameworkDeploymentRecorder();
        for (const [index, name] of FRAMEWORK_DEPLOYMENT_ORDER.entries()) {
            const parameters = deploymentParameters(name);
            const data = encodeDeployData(parameters as never);
            recorder.recordExternalDeployment(transactionHash(index), data);
        }

        expect(() => recorder.assertComplete()).not.toThrow();
        expect(recorder.pendingRecords().map(({name}) => name)).toEqual([
            ...FRAMEWORK_DEPLOYMENT_ORDER,
        ]);
    });

    test("rejects Forge constructor bytes on a no-argument component", () => {
        const recorder = new FrameworkDeploymentRecorder();
        const parameters = deploymentParameters("SimpleFactory");
        const data = `${parameters.bytecode}${"0".repeat(64)}` as Hex;
        expect(() => recorder.recordExternalDeployment(transactionHash(0), data)).toThrow(
            "must not have external constructor data",
        );
    });

    test("parses only the exact public composition evidence", () => {
        const manifest = parseFrameworkDeploymentManifest(manifestFixture());
        expect(manifest.deployments).toHaveLength(FRAMEWORK_DEPLOYMENT_COUNT);
        expect(manifest.compositionId).toBe(FRAMEWORK_COMPOSITION_ID);
    });

    test("rejects a changed record hash or hidden SCL link", () => {
        const changedHash = manifestFixture();
        changedHash.deployments[0]!.creationCodeHash = transactionHash(999);
        expect(() => parseFrameworkDeploymentManifest(changedHash)).toThrow(
            "creation code hash mismatch",
        );

        const changedLink = manifestFixture();
        changedLink.deployments[
            FRAMEWORK_DEPLOYMENT_ORDER.indexOf("HybridDeleGatorImpl")
        ]!.linkedLibraries = [DEPLOYER];
        expect(() => parseFrameworkDeploymentManifest(changedLink)).toThrow(
            "Hybrid SCL link mismatch",
        );
    });
});
