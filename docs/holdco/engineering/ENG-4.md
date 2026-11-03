# ENG-4 — agent-mcp under plain Node

Step 1 of 3 toward the `.mcpb` extension (RES-2 option B). This answers the riskiest open question in RES-2: whether the delegation stack runs under Node.

## Result

- `bun build apps/agent-mcp/index.ts --target=node --outfile "$TMPDIR/mapae-agent-mcp.js"` exits 0. The bundle is 2.5 MB, a single file, and contains 0 `Bun.` references.
- Under `node`, the bundle answers `initialize` and `tools/list`, and it answers `mapae_status` with `RUNTIME_UNAVAILABLE` when the env is empty. The process stays up and stdout carries only JSON-RPC.
- The shipped bundle, under `node`, with a fixture key, an inline `PARENT_PERMISSION_CONTEXT` and a local fake RPC and facilitator, bootstraps fully: `mapae_status` returns `ok: true`, `sessionKey` = the address derived from the fixture key, and the fake facilitator's signer. The audited Framework verifier runs unmodified and passes. The fake RPC replays `apps/agent-mcp/fixtures/framework-chain.rpc.json` (68 answers, every one asked for, no misses).
- A control test boots the same bundle with every `eth_getCode` replaced by `0x6000`. It is refused with `runtime code does not match the pinned composition`, so the passing test is not passing because verification was skipped.

## How the offline chain is made

`apps/agent-mcp/fixtures/record-framework-chain.ts` regenerates the recording without network access:

1. It starts `anvil` on loopback with chain id 91342 and genesis at the artifact's `verificationBlock` (31520346). The verifier refuses state read before that block.
2. It sets EntryPoint v0.7 from `apps/arcade-service/fixtures/entrypoint-v07.json`, a GIWA Sepolia `eth_getCode` recording already in the repo. The script checks it against the pinned `runtimeCodeHash` before use.
3. It replays every Framework deployment from the creation bytecode in the installed `@metamask/delegation-abis`, at the deployer's manifest nonces. Each address must land where the manifest says. Then it replays the `transferOwnership`/`acceptOwnership` hand-off to the recorded admin.
4. It runs the shipped Node bundle against a recording proxy in front of anvil. The recording is written only if `mapae_status` came back `ok`.

The test itself needs neither anvil nor the network.

## Node version

The test run used Node **v25.9.0**, the machine default, and Bun 1.4.2. The root `package.json` declares `engines.node >=24.22.1 <25`. The bundle was not run on a 24.x Node. Claude Desktop ships its own Node, and step 2 should pin and test against that version.

## Incompatibilities found

- **viem / smart-accounts-kit:** none under Node 25. `privateKeyToAccount`, `createPublicClient` with the throttled HTTP transport, `decodeDelegations` and `createMapaeDelegationProvider` all ran.
- **Bun APIs:** the only one on the server path was the default file reader `Bun.file(path).text()` in `agent-runtime.ts`. It is now `readFile(path, "utf8")` from `node:fs/promises`. Bun's automatic `.env` load has no Node equivalent and needs none here: the extension host passes env.
- **Workspace resolution (worktree only):** `apps/agent-mcp/node_modules` is a symlink to the main checkout, so from a worktree `@mapae/delegation` resolved to the *main* checkout's source, and the bundle still contained `Bun.file`. `apps/agent-mcp/tsconfig.json` now maps `@mapae/delegation` and `@mapae/shared` to `../../packages/*/src/index.ts`. Those are the same files the workspace link points at after merge, so the build no longer depends on where the checkout lives.

## Changes

- `packages/delegation/src/agent-runtime.ts`: the default reader is `node:fs/promises`. There is a new inline `PARENT_PERMISSION_CONTEXT` (hex or the file's JSON), which takes precedence. When it is set, the file is never read. An empty value counts as unset. A malformed value is refused by name, and the error does not echo the value. A code-only `verifyDeployment` option was added for tests; no env value reaches it.
- `apps/agent-mcp/server.ts` (new) holds the tool surface, moved unchanged from `index.ts` into `createAgentServer(loadRuntime)`. `index.ts` is now transport + `loadDelegatedAgentRuntime`.
- `apps/agent-mcp/node-bundle.test.ts` (new): the bundle tests described above.
- `apps/agent-mcp/fixtures/` (new): `framework-chain.ts` (shared fixture identity, env and stdio driver), `record-framework-chain.ts` (the recorder), `framework-chain.rpc.json` (the recording).
- `scripts/check-mcp-stdio.ts` now also measures the `--outfile` Node bundle. Output: `control 9, entry point 0, Node bundle 0`.
- `docs/mcp-guide.md` §3 gains one row.

## Deviations

- **Files.** `index.ts` was split into `server.ts` + `index.ts`, and `tsconfig.json` was edited. Both are inside `apps/agent-mcp/**`.
- **Attempt 3 vs attempt 1.** Attempt 1 covered criterion 4 with a harness that stood in for the bytecode-hash comparison; Verification rejected that. The harness is deleted. Criterion 4 is now met by the shipped bundle itself, against the replayed chain.

## Assumptions

- The inline variable is named `PARENT_PERMISSION_CONTEXT`. The ticket left the name open.
- The inline value accepts `0x…` hex or `{"permissionContext":"0x…"}` (detected by a leading `{`). Whitespace around it is trimmed. A whitespace-only value counts as unset.
- When the inline value is set, the file path is not read at all, so a missing or broken file does not block the boot.
- The fake facilitator and RPC run in the Bun test process. Only the server under test runs under `node`.
- An anvil replay built from the installed `@metamask/delegation-abis` creation bytecode, plus the repo's recorded EntryPoint runtime, is a faithful offline copy of the GIWA Framework. The pinned-hash verifier is what accepts it; I did not compare it against the live chain, because the GIWA RPC is denied from this sandbox.
- The code-only `verifyDeployment` option stays. Only the `agent-runtime.test.ts` precedence tests use it, so they need no RPC. No env value reaches it, and the shipped bundle never passes it.
- The recording is committed (about 310 KB). Regenerating it needs Foundry's `anvil`; running the test does not.

## Rollback

Revert the merge commit. Nothing else depends on `PARENT_PERMISSION_CONTEXT`, `createAgentServer` or the tsconfig paths. `PARENT_PERMISSION_CONTEXT_PATH` behaves as it did before.
