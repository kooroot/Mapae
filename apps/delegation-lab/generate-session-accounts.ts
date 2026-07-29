import {redactForLog} from "@mapae/shared";
import {chmod, mkdir} from "node:fs/promises";
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
        throw new Error(
            "session accounts already exist; refusing to rotate or overwrite them implicitly",
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
    await Bun.write(SECRET_PATH, `${JSON.stringify(accounts, null, 2)}\n`);
    await chmod(SECRET_PATH, 0o600);
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
