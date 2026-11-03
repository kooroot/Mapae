# ENG-4 — agent-mcp under plain Node

Step 1 of 3 toward the `.mcpb` extension (RES-2 option B). This answers the riskiest open question in RES-2: whether the delegation stack runs under Node.

## Result

- `bun build apps/agent-mcp/index.ts --target=node --outfile "$TMPDIR/mapae-agent-mcp.js"` exits 0. The bundle is 2.5 MB, a single file, and contains 0 `Bun.` references.
- Under `node`, the bundle answers `initialize` and `tools/list`, and it answers `mapae_status` with `RUNTIME_UNAVAILABLE` when the env is empty. The process stays up and stdout carries only JSON-RPC.
- I ran the shipped bundle under `node` with a fixture key, an inline `PARENT_PERMISSION_CONTEXT`, and a local fake RPC and facilitator. It got through key parsing, the inline permission, the deployment and manifest files, the facilitator `/supported` call and viem's HTTP client. The audited Framework verifier then ran against the fake chain (`eth_getCode` was served) and rejected its bytecode: `SimpleFactory runtime code does not match the pinned composition`.
- `node-bootstrap-harness.ts` uses the same server and the same `loadDelegatedAgentRuntime`, but a stand-in replaces the bytecode-hash comparison. The stand-in still drives viem over HTTP (`eth_chainId`, `eth_blockNumber`). Under `node`, `mapae_status` returns `ok: true` and `sessionKey` = the address derived from the fixture key. The smart-accounts kit decodes the inline permission and builds the leaf provider.

## Node version

The test run used Node **v25.9.0**, the machine default, and Bun 1.4.2. The root `package.json` declares `engines.node >=24.22.1 <25`. The bundle was not run on a 24.x Node. Claude Desktop ships its own Node, and step 2 should pin and test against that version.

## Incompatibilities found

- **viem / smart-accounts-kit:** none under Node 25. `privateKeyToAccount`, `createPublicClient` with the throttled HTTP transport, `decodeDelegations` and `createMapaeDelegationProvider` all ran.
- **Bun APIs:** the only one on the server path was the default file reader `Bun.file(path).text()` in `agent-runtime.ts`. It is now `readFile(path, "utf8")` from `node:fs/promises`. Bun's automatic `.env` load has no Node equivalent and needs none here: the extension host passes env.
- **Workspace resolution (worktree only):** `apps/agent-mcp/node_modules` is a symlink to the main checkout, so from a worktree `@mapae/delegation` resolved to the *main* checkout's source, and the bundle still contained `Bun.file`. `apps/agent-mcp/tsconfig.json` now maps `@mapae/delegation` and `@mapae/shared` to `../../packages/*/src/index.ts`. Those are the same files the workspace link points at after merge, so the build no longer depends on where the checkout lives.

## Changes

- `packages/delegation/src/agent-runtime.ts`: the default reader is `node:fs/promises`. There is a new inline `PARENT_PERMISSION_CONTEXT` (hex or the file's JSON), which takes precedence. When it is set, the file is never read. An empty value counts as unset. A malformed value is refused by name, and the error does not echo the value. A code-only `verifyDeployment` option was added for tests; no env value reaches it.
- `apps/agent-mcp/server.ts` (new) holds the tool surface, moved unchanged from `index.ts` into `createAgentServer(loadRuntime)`. `index.ts` is now transport + `loadDelegatedAgentRuntime`.
- `apps/agent-mcp/node-bootstrap-harness.ts` (new, test-only) refuses any non-loopback RPC.
- `apps/agent-mcp/node-bundle.test.ts` (new): the bundle tests described above.
- `scripts/check-mcp-stdio.ts` now also measures the `--outfile` Node bundle. Output: `control 9, entry point 0, Node bundle 0`.
- `docs/mcp-guide.md` §3 gains one row.

## Deviations

- **Criterion 4, which requires the shipped bootstrap to return no RUNTIME_UNAVAILABLE.** I could not meet it as written. The verifier compares the live runtime bytecode of 38 contracts against pinned hashes. A fake RPC cannot serve that bytecode without a copy of the chain, and none is available: the GIWA RPC is denied from this sandbox, and the Framework is not compiled locally. `live-verifier.test.ts` already records the same limit. The criterion is covered in two parts instead. (a) The shipped bundle runs under Node all the way to the verifier, and the verifier runs. (b) A harness swaps only the hash comparison and shows a full bootstrap and the fixture address. Adding an env switch that skips verification was rejected, because it would be a production bypass of the audited-composition check.
- **Files.** `index.ts` was split into `server.ts` so the harness can reuse the server, and `tsconfig.json` was edited. Both are inside `apps/agent-mcp/**`.

## Assumptions

- The inline variable is named `PARENT_PERMISSION_CONTEXT`. The ticket left the name open.
- The inline value accepts `0x…` hex or `{"permissionContext":"0x…"}` (detected by a leading `{`). Whitespace around it is trimmed. A whitespace-only value counts as unset.
- When the inline value is set, the file path is not read at all, so a missing or broken file does not block the boot.
- The fake facilitator and RPC run in the Bun test process. Only the server under test runs under `node`.

## Rollback

Revert the merge commit. Nothing else depends on `PARENT_PERMISSION_CONTEXT`, `createAgentServer` or the tsconfig paths. `PARENT_PERMISSION_CONTEXT_PATH` behaves as it did before.
