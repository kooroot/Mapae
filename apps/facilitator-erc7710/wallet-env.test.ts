import {expect, test} from "bun:test";

for (const service of ["facilitator-erc7710", "account-bootstrap"]) {
    for (const obsolete of ["RELAYER_ADDRESS", "RELAYER_PRIVATE_KEY"]) {
        test(`${service} refuses ${obsolete} even when the current name is also present`, async () => {
            const secret = "fixture-secret-must-not-appear";
            const child = Bun.spawn([process.execPath, "--env-file=/dev/null", "run", "index.ts"], {
                cwd: new URL(`../${service}/`, import.meta.url).pathname,
                env: {
                    PATH: process.env.PATH ?? "",
                    [obsolete]: secret,
                    FACILITATOR_SIGNER_ADDRESS: "0x1111111111111111111111111111111111111111",
                },
                stdout: "pipe", stderr: "pipe",
            });
            const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
            expect(await child.exited).not.toBe(0);
            expect(output).toContain(`${obsolete} is obsolete`);
            expect(output).not.toContain(secret);
        });
    }
}
