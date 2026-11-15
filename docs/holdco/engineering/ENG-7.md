# ENG-7 — Restore the README test counts

Branch `t/ENG-7`, base `0f70626` (main after ENG-6). Action `code.merge.docs`.

## Change

README.md and README.ko.md: digits only, two lines each (badge line 14 and the body line, README.md:111 / README.ko.md:108).

| Figure | Was | Now |
|---|---|---|
| TS total (badge and body) | 1959 | 2009 |
| shared/delegation/seller/store/facilitator/shop/scripts | 1315 | 1343 |
| MCP | 3 | 18 |
| web | 606 | 613 |
| docs | 35 | 35 (unchanged) |
| Foundry | 78 | 78 (unchanged, confirmed by forge) |

1343 + 18 + 613 + 35 = 2009. `scripts/check-test-counts.ts` and `scripts/check-test-counts.test.ts` are untouched.

## Per-suite counts collected

As collected by `bun run check:counts` (`bun test -t <no match>` per suite in SUITES order):

- first suite (shared/delegation/seller/store/facilitator/shop/scripts): **1343**
- MCP (`apps/agent-mcp`): **18**
- web (`apps/web`): **613**
- docs (`apps/docs`): **35**
- Foundry: forge **was available** (`~/.foundry/bin/forge`); `forge test --list --json` in `contracts/` lists **78**

## Checker output

Failing, on the branch base `0f70626` (with the Arcade assets installed, see Environment notes):

```
$ bun run scripts/check-test-counts.ts
[counts] stated test counts do not match reality:

  ✗ README.md: says 1959 TypeScript tests, the suites collect 2009
  ✗ README.md: breakdown says 1315 for shared/delegation/seller/store/facilitator/shop/scripts, it collects 1343
  ✗ README.md: breakdown says 3 for MCP, it collects 18
  ✗ README.md: breakdown says 606 for web, it collects 613
  ✗ README.ko.md: says 1959 TypeScript tests, the suites collect 2009
  ✗ README.ko.md: breakdown says 1315 for shared/delegation/seller/store/facilitator/shop/scripts, it collects 1343
  ✗ README.ko.md: breakdown says 3 for MCP, it collects 18
  ✗ README.ko.md: breakdown says 606 for web, it collects 613

error: script "check:counts" exited with code 1
```

Passing, on `t/ENG-7`:

```
$ bun run scripts/check-test-counts.ts
[counts] 2 documents state 2009 TypeScript + 78 Foundry tests, and that is how many there are
```

Also on `t/ENG-7`: `bun run typecheck` exits 0; `bun run check:docs` prints `[docs] 29 documents — commands, links, document references and addresses check out` and exits 0.

## Environment notes

In a fresh worktree `bun run check:counts` first fails with a different error: `✗ web: could not read a test count from bun`. Four web test files import `apps/web/public/arcade/wardrobe/fit.json`, and `/apps/web/public/arcade/` is gitignored. CI installs that folder from the pinned `kooroot/Mapae-arcade-asset` checkout (`.github/workflows/ci.yml`, "Verify and install Arcade assets"). Locally I did the same by copying `/Users/kooroot/Desktop/dev/Mapae/apps/web/public/arcade/` into the worktree. The copy is gitignored and not part of the diff. A Verification worktree has to do the same before `check:counts` can count the web suite.

## Assumptions

- The local copy of the Arcade assets in the main checkout matches what CI installs from the pinned asset repo. Only the web suite's collection depends on it, and the count it gives (613) is the one ENG-6 reported.
- The counts are the ones collected at base `0f70626`. A merge to main that adds tests before this one lands would make the numbers stale again.
