import {redactForLog} from "@mapae/shared";
import {mkdir, writeFile} from "node:fs/promises";
import nodePath from "node:path";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";

/**
 * One personal agent session key, apart from the demo set.
 *
 * `sessions:generate` writes the five-role demo identities and refuses to run
 * when its outputs exist — and `deployments/d3-session-addresses.json` is
 * committed, so on a fresh clone it always refuses. That refusal is correct for
 * the demo set (those addresses are what the docs cite) and useless for a new
 * user who only needs a key to put in the Studio form. This command is that
 * user's path: one keypair, secret to `.secrets/`, address to stdout.
 *
 * Paths are anchored to this file, not the cwd — run from anywhere, the key
 * still lands inside the repo where `.gitignore` covers it. The write sets
 * mode 600 at open time and refuses an existing file at the syscall (`wx`),
 * so there is no world-readable window and no check-then-write race.
 */
const SECRETS_DIR = nodePath.resolve(import.meta.dir, "../../.secrets");
const SECRET_PATH = nodePath.join(SECRETS_DIR, "agent-session-key.json");

async function main(): Promise<void> {
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;

    await mkdir(SECRETS_DIR, {recursive: true, mode: 0o700});
    try {
        await writeFile(SECRET_PATH, `${JSON.stringify({address, privateKey}, null, 2)}\n`, {
            mode: 0o600,
            flag: "wx",
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(
                `an agent session key already exists at ${SECRET_PATH}; ` +
                    "refusing to overwrite it — move or delete the file to rotate",
            );
        }
        throw error;
    }

    console.log("generated 1 agent session key");
    console.log(`secret key  ${SECRET_PATH} (mode 600, gitignored)`);
    console.log(`address     ${address}`);
    console.log("put the address in the Studio form; put the key in apps/delegated-agent/.env");
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
