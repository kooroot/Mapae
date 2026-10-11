import {expect, test} from "bun:test";

// A fresh process: this runner's module cache may already hold config.ts.
test("loading the package's kit wrappers raises the kit's analytics opt-out", () => {
    const {DO_NOT_TRACK: _, ...env} = process.env;
    const run = Bun.spawnSync(
        [process.execPath, "-e", `await import(${JSON.stringify(`${import.meta.dir}/config.ts`)}); console.log(process.env.DO_NOT_TRACK);`],
        {env},
    );
    expect(run.stdout.toString().trim()).toBe("1");
});
