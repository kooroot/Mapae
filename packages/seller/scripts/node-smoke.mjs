#!/usr/bin/env node
// Node-runtime smoke for @mapae/seller: the tarball `npm publish` would ship is installed
// with npm into a fresh project outside the repository and exercised under `node`.
//
// NEEDS THE NPM REGISTRY (network): the tarball's peers, hono and viem, are installed
// from it. Nothing here is shipped — `files` stays ["dist", "README.md"].
//
//   bun run smoke:node          (from packages/seller)
//
// Steps: `bun run build` → `npm pack` into a temp dir → `{"type":"module"}` project →
// `npm install <tgz> hono viem` → `node server.mjs` (node-smoke-server.mjs, copied in): a
// node:http stub facilitator answering /supported with the GIWA ERC-7710 kind, a Hono app
// with two paywalls (two different payTo) and the derived manifest, driven through
// `app.request()`. Asserted there: an unpaid request answers 402 with the erc7710 offer
// and a `resource.url` built from `baseUrl`; `GET /.well-known/mapae.json` lists both
// paywalls, each with its own payTo. The Node version is printed. Exit 0 only when every
// assertion held.
//
// The children run with NODE_OPTIONS cleared: a preload or flag inherited from the caller's
// shell must not shape what "runs under node" means here.
import {spawnSync} from "node:child_process";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const env = {...process.env, NODE_OPTIONS: ""};

function fail(message) {
    console.error(`[node-smoke] FAIL — ${message}`);
    process.exit(1);
}

function run(label, command, args, cwd) {
    console.log(`[node-smoke] ${label}`);
    const result = spawnSync(command, args, {cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
    if (result.error) fail(`${label}: ${result.error.message}`);
    if (result.status !== 0) fail(`${label}: exit ${result.status}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}

const version = (dir, name) => JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")).version;

const work = mkdtempSync(join(tmpdir(), "mapae-seller-smoke-"));
try {
    run("bun run build", "bun", ["run", "build"], PACKAGE_DIR);
    const packed = JSON.parse(
        run("npm pack", "npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], PACKAGE_DIR),
    );
    const tarball = join(work, packed[0].filename);
    console.log(`[node-smoke] tarball ${packed[0].filename} (${packed[0].entryCount} files)`);

    const project = join(work, "project");
    mkdirSync(project);
    writeFileSync(
        join(project, "package.json"),
        JSON.stringify({name: "mapae-seller-smoke", private: true, type: "module"}, null, 2),
    );
    const registry = run("npm config get registry", "npm", ["config", "get", "registry"], project).trim();
    run(
        `npm install ${packed[0].filename} hono viem (from ${registry})`,
        "npm",
        ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball, "hono", "viem"],
        project,
    );
    console.log(
        `[node-smoke] installed @mapae/seller ${version(project, "@mapae/seller")}, ` +
            `hono ${version(project, "hono")}, viem ${version(project, "viem")}`,
    );

    copyFileSync(join(SCRIPTS_DIR, "node-smoke-server.mjs"), join(project, "server.mjs"));
    console.log("[node-smoke] node server.mjs");
    const server = spawnSync("node", ["server.mjs"], {cwd: project, env, stdio: "inherit"});
    if (server.error) fail(`node: ${server.error.message}`);
    if (server.status !== 0) fail(`server.mjs exited ${server.status}`);
    console.log("[node-smoke] ok — the packed tarball runs under node");
} finally {
    rmSync(work, {recursive: true, force: true});
}
