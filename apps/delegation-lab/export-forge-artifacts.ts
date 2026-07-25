import {redactForLog} from "@mapae/shared";
import * as DelegationBytecodes from "@metamask/delegation-abis/bytecode";
import {
    FRAMEWORK_COMPOSITION_ID,
    FRAMEWORK_COMPOSITION_SPEC_HASH,
    FRAMEWORK_DEPLOYMENT_ORDER,
    FRAMEWORK_UPSTREAM,
    assertInstalledFrameworkBytecodes,
} from "@mapae/delegation";
import {mkdir, rename} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {keccak256, stringToHex, type Hex} from "viem";

function exportedBytecode(name: (typeof FRAMEWORK_DEPLOYMENT_ORDER)[number]): string {
    const exportName = name.endsWith("Impl") ? name.slice(0, -"Impl".length) : name;
    const value = (DelegationBytecodes as Record<string, unknown>)[exportName];
    if (typeof value !== "string" || !value.startsWith("0x")) {
        throw new Error(`@metamask/delegation-abis bytecode is missing for ${name}`);
    }
    return value;
}

async function writeAtomically(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), {recursive: true});
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await Bun.write(temporary, contents);
    await rename(temporary, path);
}

async function main(): Promise<void> {
    assertInstalledFrameworkBytecodes();

    const bytecodes = Object.fromEntries(
        FRAMEWORK_DEPLOYMENT_ORDER.map((name) => [name, exportedBytecode(name)]),
    );
    const proxy = (DelegationBytecodes as Record<string, unknown>).ERC1967Proxy;
    if (typeof proxy !== "string" || !/^0x[0-9a-fA-F]+$/.test(proxy)) {
        throw new Error("@metamask/delegation-abis ERC1967Proxy bytecode is missing");
    }

    const payload = {
        schemaVersion: 1,
        compositionId: FRAMEWORK_COMPOSITION_ID,
        compositionSpecHash: FRAMEWORK_COMPOSITION_SPEC_HASH,
        sourceRevision: FRAMEWORK_UPSTREAM.delegationFrameworkRevision,
        package: {
            name: "@metamask/delegation-abis",
            version: FRAMEWORK_UPSTREAM.delegationAbis.version,
            integrity: FRAMEWORK_UPSTREAM.delegationAbis.npmIntegrity,
        },
        deploymentCount: FRAMEWORK_DEPLOYMENT_ORDER.length,
        order: FRAMEWORK_DEPLOYMENT_ORDER,
        bytecodes,
        ownerProxy: {
            ERC1967Proxy: proxy,
            creationCodeHash: keccak256(proxy as Hex),
        },
    };
    const bundleHash = keccak256(stringToHex(JSON.stringify(payload)));
    const output =
        process.env.FORGE_FRAMEWORK_ARTIFACT_PATH?.trim() ||
        resolve(import.meta.dir, "../../contracts/generated/framework-artifacts.json");
    await writeAtomically(
        output,
        `${JSON.stringify({...payload, bundleHash}, null, 2)}\n`,
    );
    console.log(`Forge Framework artifacts written to ${output}`);
    console.log(`  composition ${FRAMEWORK_COMPOSITION_ID}`);
    console.log(`  units       ${FRAMEWORK_DEPLOYMENT_ORDER.length}`);
    console.log(`  bundle hash ${bundleHash}`);
    console.log("No private key was read and no RPC request was made.");
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
