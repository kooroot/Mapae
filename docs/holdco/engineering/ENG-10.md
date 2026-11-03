# ENG-10 — Arcade asset sync script

`bun scripts/sync-arcade-assets.ts` installs the gitignored Arcade art into
`apps/web/public/arcade/` in any checkout, including a linked worktree, so `test:web`,
`check:counts` and `build:web` run on the full suite without a symlink or a manual rsync.

## Resolution order

1. `$MAPAE_ARCADE_ASSET_DIR`, when set and non-empty.
2. `<dirname of git common dir>/../Mapae-arcade-asset`. `git rev-parse --git-common-dir`
   returns the main checkout's `.git` even inside a linked worktree, so a worktree at
   `Mapae/.claude/worktrees/t-<id>` finds `Mapae-arcade-asset` beside `Mapae/`. A plain
   `../` from the worktree root would point into `.claude/worktrees/`, which is why the
   README's manual block does not work there.
3. `<repo root>/../Mapae-arcade-asset`.

The first one that is a directory wins. When none is, the script exits 1 and prints every
path it tried plus the clone command from `apps/web/README.md`. The only subprocess is
`git rev-parse --git-common-dir`.

## What is verified and what is copied

- Every line of `<asset repo>/SHA256SUMS` is parsed (`<sha256>  <path>`; paths that are
  absolute or leave the repository are rejected). Each file's SHA-256 is computed
  in-process with `Bun.CryptoHasher`. Any missing file or digest mismatch is listed by
  name and the script exits 1 **before any copy**.
- On success `<asset repo>/arcade/` is copied recursively into `apps/web/public/arcade/`,
  skipping any directory named `.git` or `previews` at any depth. Files are overwritten,
  never deleted, so a re-run leaves the same tree.
- It prints the number of files verified and copied, and the asset repository HEAD, read
  from `.git/HEAD`, loose refs or `packed-refs` (no git subprocess); omitted when unreadable.

## Outputs (worktree `t-ENG-10`, which had no `apps/web/public/arcade`)

```
$ ls apps/web/public/arcade
ls: apps/web/public/arcade: No such file or directory
$ bun scripts/sync-arcade-assets.ts
verified 150 files from /Users/kooroot/Desktop/dev/Mapae-arcade-asset at 17811d4513458c7e86cddbd7f00b0c55289b54fb
copied 150 files into /Users/kooroot/Desktop/dev/Mapae/.claude/worktrees/t-ENG-10/apps/web/public/arcade
exit=0
$ bun scripts/sync-arcade-assets.ts   # second run
verified 150 files from /Users/kooroot/Desktop/dev/Mapae-arcade-asset at 17811d4513458c7e86cddbd7f00b0c55289b54fb
copied 150 files into /Users/kooroot/Desktop/dev/Mapae/.claude/worktrees/t-ENG-10/apps/web/public/arcade
exit=0
$ cmp <listing with sizes after run 1> <listing after run 2> && echo identical
identical 150
$ find apps/web/public/arcade -name .git -o -name previews
(nothing)
```

The asset HEAD equals the commit CI pins (`.github/workflows/ci.yml`, `ref: 17811d4…`).

```
$ bun test scripts/sync-arcade-assets.test.ts
 7 pass
 0 fail
 23 expect() calls

$ bun run test:web
 626 pass
 0 fail
 17701 expect() calls
Ran 626 tests across 60 files. [2.48s]

$ bun run test:ts
 1350 pass
 0 fail
Ran 1350 tests across 79 files. [7.82s]

$ bun run check:counts
[counts] 2 documents state 2035 TypeScript + 78 Foundry tests, and that is how many there are

$ bun run build:web
✓ built in 5.32s
build exit=0

$ bun run typecheck   # exit 0
$ bun run check:docs
[docs] 29 documents — commands, links, document references and addresses check out
```

`bun run build:web` ran directly in this sandbox; the `--configLoader runner` fallback was
not needed. Note: `check:counts` needs `@mapae/seller` built (`bun run typecheck` runs
`build:seller`); before that it fails with "could not read a test count", independent of
the art.

The test file covers: (a) success copies exactly the `arcade/` files, nothing from a
nested `.git` or `previews`; (b) a tampered file exits non-zero, names it, copies nothing;
(c) a missing listed file likewise; (d) no asset directory: non-zero and every tried path
plus the clone command printed; (e) `$MAPAE_ARCADE_ASSET_DIR` comes first, and (e') without
it a linked worktree resolves the sibling of the main checkout; (f) a second run is
idempotent. All in a temporary directory, no network.

## Counts

The new suite is under `scripts/`, which `scripts/check-test-counts.ts` counts in the
shared/…/scripts suite: README.md and README.ko.md digits go 2028 → 2035 and 1343 → 1350
(badge and body line, digits only).

## Changed files

`scripts/sync-arcade-assets.ts`, `scripts/sync-arcade-assets.test.ts`,
`apps/web/README.md` (one Korean sentence after the unchanged manual block),
`README.md`, `README.ko.md` (digits), this file. Nothing under `apps/web/public/arcade`
is committed (gitignored).

## Rollback

`git revert` of the merge commit. The script is a developer tool: nothing is deployed and
the app Worker is untouched. Removing it restores the manual rsync block as the only path.

## Assumptions

- Copying overwrites but never deletes stale files in the target, matching the README's
  `rsync -a` (no `--delete`) and CI's `cp -R`.
- `.git` and `previews` are skipped at every depth, not only at the asset repository root.
- An empty `$MAPAE_ARCADE_ASSET_DIR` is treated as unset; a set but non-existent one falls
  through to the sibling lookups (it is still listed among the tried paths if none exists).
- Verification covers exactly the files listed in `SHA256SUMS`; files under `arcade/` that
  are not listed are still copied (CI behaves the same way).
- Tests call the exported `syncArcadeAssets`/`candidatePaths` rather than spawning the CLI,
  so they never write the real `apps/web/public/arcade`; the CLI exit code is the returned
  `code`.
