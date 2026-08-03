import {redactForLog} from "@mapae/shared";
import {mkdir, writeFile} from "node:fs/promises";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";

const SECRET_PATH = "../../.secrets/d3-session-accounts.json";
const PUBLIC_PATH = "../../deployments/d3-session-addresses.json";
const roles = [
    "open-agent",
    "vendor-agent",
    "team-manager",
    "child-a",
    "child-b",
] as const;

async function main(): Promise<void> {
    if ((await Bun.file(SECRET_PATH).exists()) || (await Bun.file(PUBLIC_PATH).exists())) {
        // On a fresh clone this fires every time: the address file is committed as the
        // demo deployment's canonical record, and rotating it would desync the docs
        // that cite those addresses. A new user wanting their own key never needed
        // this five-role set — point them at the single-key command instead.
        throw new Error(
            "the demo session set already exists (its address file is committed); " +
                "refusing to rotate it. For a personal agent key run `bun run agent-key:new`",
        );
    }
    const accounts = Object.fromEntries(
        roles.map((role) => {
            const privateKey = generatePrivateKey();
            return [role, {address: privateKeyToAccount(privateKey).address, privateKey}];
        }),
    );
    const publicAddresses = Object.fromEntries(
        Object.entries(accounts).map(([role, account]) => [role, account.address]),
    );

    await mkdir("../../.secrets", {recursive: true, mode: 0o700});
    // Mode set at open time — a write-then-chmod leaves the key world-readable
    // for a window, and forever if the process dies between the two calls.
    await writeFile(SECRET_PATH, `${JSON.stringify(accounts, null, 2)}\n`, {mode: 0o600});
    await Bun.write(PUBLIC_PATH, `${JSON.stringify(publicAddresses, null, 2)}\n`);

    console.log(`generated ${roles.length} isolated session accounts`);
    console.log(`secret keys  ${SECRET_PATH} (mode 600, gitignored)`);
    console.log(`addresses    ${PUBLIC_PATH}`);
    for (const [role, address] of Object.entries(publicAddresses)) {
        console.log(`  ${role.padEnd(14)} ${address}`);
    }
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
