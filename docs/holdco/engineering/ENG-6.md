# ENG-6 — Studio "Claude Desktop" path (step 3 of 3 toward the .mcpb extension)

## What shipped

- **Public download path:** `/mapae.mcpb` on the app surface (`https://app.mapae.io/mapae.mcpb` after deploy). Constant `DESKTOP_EXTENSION_PATH` in `apps/web/src/lib/desktop-extension.ts`.
- **Headers:** `apps/web/public/_headers` serves `/mapae.mcpb` with `Content-Type: application/zip`, `Content-Disposition: attachment; filename="mapae.mcpb"`, `Cache-Control: public, max-age=300`. Asserted by `apps/web/src/lib/desktop-extension.test.ts`.
- **Studio card:** every agent card in `apps/web/src/dapp/AgentGrantList.tsx` gains a "Claude Desktop에 설치 / Install in Claude Desktop" block (`DesktopInstall`): download link, "① 에이전트 키 복사 / ① Copy agent key" (exactly `grant.agentKey.privateKey`; disabled with the "held only in the tab that created it" explanation when the grant has no key), "② 권한 코드 복사 / ② Copy permission code" (exactly `grant.artifact.permissionContext`). "MCP 연결 번들 복사" is unchanged.
- **Guide:** `docs/mcp-guide.md` §2.0 "Claude Desktop 확장 — 설치 없이", and the §2 Bun row now applies to §2.1–§2.3 only.

## How the archive reaches the build output

`apps/agent-mcp/mcpb/pack.ts` gained `--copy-to <path>` (resolved against the cwd), which writes a byte-identical copy of `apps/agent-mcp/mcpb/dist/mapae.mcpb` after packing.

- Root `bun run build:mcpb` now runs `pack.ts --copy-to apps/web/public/mapae.mcpb`.
- `apps/web`'s `build:app` (and so `deploy:app`) packs first: `bun run ../agent-mcp/mcpb/pack.ts --copy-to public/mapae.mcpb && … vite build`, so a deploy can never ship a page whose link 404s.
- Vite copies `public/` into `apps/web/dist/client/`, so the archive lands at `dist/client/mapae.mcpb`. `apps/web/public/mapae.mcpb` is gitignored (one `.gitignore` line); the archive is never committed.

Verified: `bun run build:mcpb && bun run build:web` → `cmp apps/web/dist/client/mapae.mcpb apps/agent-mcp/mcpb/dist/mapae.mcpb` reports no difference; `git status` shows no .mcpb.

## Operator deploy (by hand; no agent deploys)

Fill the ENG-5 결과 table (Claude Desktop install on Free and on Pro) in `docs/holdco/engineering/ENG-5.md` **before** deploying — that check gates the deploy, not this merge. Then, from the repository root:

```bash
bun run deploy:app
```

(= `cd apps/web && bun run build:app && wrangler deploy --env app`; env `app` in `apps/web/wrangler.jsonc` is Worker `mapae-app` on `app.mapae.io`, per `docs/infra-map.md`.) Check afterwards: `curl -sI https://app.mapae.io/mapae.mcpb` shows `content-type: application/zip` and `content-disposition: attachment`.

The landing and faucet builds (`build:landing`, `build:faucet`) do not pack, but if `apps/web/public/mapae.mcpb` exists locally from an earlier `build:mcpb`, they will also ship it at `/mapae.mcpb`. Harmless (same public file), noted for completeness.

## Rollback

`git revert <merge commit>` on `main`, then redeploy the previous build with `bun run deploy:app`. Merging alone publishes nothing: CI only verifies; the link is live only after the Operator's deploy.

## How tested

- `bun test apps/web/src/lib/desktop-extension.test.ts` — key present (exact 0x + 64 hex, no newline, no `=`), key absent → unavailable, path constant, `_headers` entry.
- `bun test apps/web/src/dapp/AgentGrantList.test.tsx` — renders the card in ko and en: download link `href="/mapae.mcpb" download="mapae.mcpb"`, both labels; without agentKey the key button is `disabled` and the link stays; clicking the two buttons writes exactly the key hex and exactly the permission context to a stubbed `navigator.clipboard`.
- `bun run test:web` 613 pass; `bun test apps/agent-mcp` 18 pass; `bun run check:mcp-stdio`, `bun run typecheck`, `bun run check:docs` pass; `bun run build:web` exits 0.

## Assumptions

1. `/mapae.mcpb` (recommended path) and `application/zip`; `Cache-Control: public, max-age=300` so a re-pack shows up within minutes (the file is not content-hashed).
2. `build:app` packs before building so the deployed app always carries the archive; this is a scripts-only change in `apps/web/package.json`.
3. The root `build:mcpb` entry was edited (not added) to write the copy — counted as the one allowed root scripts change.
4. The Desktop block uses the existing `mapae-action` button classes; no CSS file is in this ticket's scope, so the new `studio-desktop-install` section has no dedicated styling yet.
5. The block shows on every card, including imported/recovered grants without a key (download and permission code still useful; key button disabled with explanation).
6. Guide §2.0 states the Revoke tab label as "회수" (ko) / "Revoke" (en) from `apps/web/src/lib/studio-sections.ts`, and Desktop stores `sensitive` fields in the OS keychain per the manifest descriptions.

## Environment notes (this session)

- In this worktree `apps/web/public/arcade/` (gitignored art) is absent and the shared `node_modules` is not writable from the sandbox, so `test:web` and `build:web` were run with a temporary symlink to the main checkout's `public/arcade` (removed afterwards) and `vite build --configLoader runner`. Verification's checkout needs those assets too.
- Follow-up (out of scope here): `bun run check:counts` fails on README.ko.md — MCP count already stale (3 vs 18, from ENG-4/5) and web 606 → 613 from this ticket's 7 new tests.
