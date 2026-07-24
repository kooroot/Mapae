import {describe, expect, test} from "bun:test";
import * as DelegationBytecodes from "@metamask/delegation-abis/bytecode";
import {getAddress, type Hex} from "viem";
import {
    FRAMEWORK_COMPONENT_BY_NAME,
    FRAMEWORK_COMPOSITION_ID,
    FRAMEWORK_COMPOSITION_SPEC_HASH,
    FRAMEWORK_DEPLOYMENT_COUNT,
    FRAMEWORK_DEPLOYMENT_ORDER,
    GIWA_ENTRY_POINT_V07_IDENTITY,
    assertInstalledFrameworkBytecodes,
    identifyFrameworkDeploymentBytecode,
    normalizeBytecode,
    verifyFrameworkRuntimeCode,
    verifyGiwaEntryPointRuntimeCode,
} from "./composition.js";

const LINK_ADDRESS = getAddress("0x1000000000000000000000000000000000000001");

function bytecodeExportName(name: (typeof FRAMEWORK_DEPLOYMENT_ORDER)[number]): string {
    return name.endsWith("Impl") ? name.slice(0, -"Impl".length) : name;
}

function installedBytecode(name: (typeof FRAMEWORK_DEPLOYMENT_ORDER)[number]): string {
    const value = (DelegationBytecodes as unknown as Record<string, unknown>)[
        bytecodeExportName(name)
    ];
    if (typeof value !== "string") throw new Error(`missing test bytecode for ${name}`);
    return value;
}

function linkedHybridBytecode(): Hex {
    return installedBytecode("HybridDeleGatorImpl").replace(
        /__\$b8f96b288d4d0429e38b8ed50fd423070f\$__/gu,
        LINK_ADDRESS.slice(2),
    ) as Hex;
}

describe("pinned Framework composition", () => {
    test("freezes the exact 38-unit order and composition identity", () => {
        expect(FRAMEWORK_DEPLOYMENT_COUNT).toBe(38);
        expect(FRAMEWORK_DEPLOYMENT_ORDER).toHaveLength(38);
        expect(FRAMEWORK_COMPOSITION_SPEC_HASH).toBe(
            "0xe297f795868c4f18206506c93ae5984df86e73d8d05c388b32404f866fa49782",
        );
        expect(FRAMEWORK_COMPOSITION_ID).toBe(
            "mapae-sak-1.7.0-d90569fa-df-d0ebab53-e297f795",
        );
        expect(GIWA_ENTRY_POINT_V07_IDENTITY.address).toBe(
            getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032"),
        );
        expect(GIWA_ENTRY_POINT_V07_IDENTITY.senderCreator).toBe(
            getAddress("0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C"),
        );
    });

    test("matches every installed official creation bytecode", () => {
        expect(() => assertInstalledFrameworkBytecodes()).not.toThrow();
        for (const name of FRAMEWORK_DEPLOYMENT_ORDER) {
            const bytecode =
                name === "HybridDeleGatorImpl"
                    ? linkedHybridBytecode()
                    : installedBytecode(name);
            expect(identifyFrameworkDeploymentBytecode(bytecode)).toBe(name);
        }
    });

    test("accepts only the declared Hybrid library link range", () => {
        expect(identifyFrameworkDeploymentBytecode(linkedHybridBytecode())).toBe(
            "HybridDeleGatorImpl",
        );
        const body = linkedHybridBytecode().slice(2);
        const mutated = `0x${body.slice(0, -2)}${body.endsWith("00") ? "01" : "00"}`;
        expect(() => identifyFrameworkDeploymentBytecode(mutated)).toThrow(
            "not in the pinned Framework composition",
        );
    });

    test("rejects invalid normalization ranges and runtime identities", () => {
        expect(() =>
            normalizeBytecode("0x0000", [
                {start: 0, length: 2},
                {start: 1, length: 1},
            ]),
        ).toThrow("invalid or overlapping");
        expect(() =>
            normalizeBytecode("0x00", [{start: 1, length: 1}]),
        ).toThrow("invalid or overlapping");
        expect(() => verifyFrameworkRuntimeCode("SimpleFactory", "0x01")).toThrow(
            "does not match the pinned composition",
        );
        expect(() => verifyGiwaEntryPointRuntimeCode("0x01")).toThrow(
            "runtime identity mismatch",
        );
    });

    test("marks only the linked SCL library as hidden from the SDK environment", () => {
        const hidden = FRAMEWORK_DEPLOYMENT_ORDER.filter(
            (name) => FRAMEWORK_COMPONENT_BY_NAME[name].hiddenFromEnvironment,
        );
        expect(hidden).toEqual(["SCL_RIP7212"]);
    });
});
