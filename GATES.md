# Gates: reliable settlements and scheduled payments

OWNS: apps/**, packages/**, scripts/**, docs/**, .github/workflows/ci.yml, README.md, README.ko.md, package.json, bun.lock, PLAN.md, GATES.md

Scope: Complete recovery, exact durable accounting, mined-failure semantics, real-process E2E and bounded scheduled payments.

- [x] G1: Recovery reconstructs and resends only the original transaction; nonce reservations survive restart.
  CHECK: bun test apps/facilitator-erc7710/recovery.test.ts
  EXPECT: 0 fail
  EVIDENCE: exit=0; EXPECT=matched; shell=/bin/sh; cwd=/Users/kooroot/Desktop/dev/Mapae; path=9e2d806cf933/50 entries; output=33 expect() calls | Ran 9 tests across 1 file. [229.00ms]

- [x] G2: Atomic budget reservations and receipt reconciliation survive restart and midnight without duplicate accounting.
  CHECK: bun test packages/store/src/settlement.test.ts
  EXPECT: 0 fail
  EVIDENCE: exit=0; EXPECT=matched; shell=/bin/sh; cwd=/Users/kooroot/Desktop/dev/Mapae; path=9e2d806cf933/50 entries; output=34 expect() calls | Ran 8 tests across 1 file. [56.00ms]

- [x] G3: A mined revert is returned and recorded with transaction identity and gas, separately from validation rejection.
  CHECK: bun test apps/facilitator-erc7710/settlement.test.ts
  EXPECT: 0 fail
  EVIDENCE: exit=0; EXPECT=matched; shell=/bin/sh; cwd=/Users/kooroot/Desktop/dev/Mapae; path=9e2d806cf933/50 entries; output=10 expect() calls | Ran 3 tests across 1 file. [147.00ms]

- [x] G4: Real HTTP processes recover across forced termination and lost RPC answers against Anvil with no duplicate on-chain payment.
  CHECK: bun run test:e2e:recovery
  EXPECT: recovery E2E PASS
  EVIDENCE: exit=0; EXPECT=matched; shell=/bin/sh; cwd=/Users/kooroot/Desktop/dev/Mapae; path=9e2d806cf933/50 entries; output=recovery E2E PASS: process kill, lost answer, delayed receipt, restart, concurrency, revert, balances and durable accounting | $ bun run scripts/recovery-e2e.ts

- [x] G5: Scheduled payments enforce time, recipient, amount, total and run caps; cancellation, retry and interruption survive restart.
  CHECK: bun run test:scheduler
  EXPECT: 0 fail
  EVIDENCE: exit=0; EXPECT=matched; shell=/bin/sh; cwd=/Users/kooroot/Desktop/dev/Mapae; path=9e2d806cf933/50 entries; output=50 expect() calls | Ran 10 tests across 1 file. [189.00ms]

- [x] G6: Complete repository types, docs, tests, builds and contracts pass.
  CHECK: bun run check
  EXPECT: 0 failed
  EVIDENCE: exit=0; EXPECT=matched; shell=/bin/sh; cwd=/Users/kooroot/Desktop/dev/Mapae; path=9e2d806cf933/50 entries; output=$ make -C contracts test | $ bun run export-forge-artifacts.ts
