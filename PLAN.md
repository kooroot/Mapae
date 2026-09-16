# Mapae settlement reliability and scheduled payments

## Contract

Implement all five improvements identified on 2026-09-13, in order, on the existing working tree. Preserve prior changes and the pre-existing submodule dirt. Never broadcast on the public chain during validation. No backward-compatibility paths or schema migrations. No secret keys, payment signatures or permission contexts in the database.

## Steps

1. **Transaction recovery (verified).** Persist the unsigned transaction envelope (nonce, gas, fees, chain, signer) with the intent and hash. On retry reconstruct from the presented permission; require exactly the original hash before sending the same bytes. Persist nonce reservations so an interrupted send cannot give its nonce to a different intent. Serialize preparation/claim within one coordinator.
2. **Durable gas accounting (verified).** Claim the intent and reserve total/payer budgets in one SQLite transaction. Reconcile the actual receipt cost exactly once on the original UTC day, including after restart. Remove the facilitator's obsolete in-memory admission path.
3. **Mined failures (verified).** Store terminal mined outcomes with transaction hash and gas usage. Return settlement_reverted separately from pre-broadcast rejection. Terminal retries never resend or count the event twice.
4. **Real process E2E (verified).** Use disposable Anvil, real signed transactions and HTTP service processes. Kill at the journal-before-send boundary, lose a send response, delay receipt visibility, restart and retry; test concurrent requests and on-chain reverts. Assert balances, nonce, journal, original-day budgets and ledger counts. Add the suite to CI without real keys or fork artifacts.
5. **Scheduled/conditional payments (verified).** Local agent CLI with durable jobs/runs: add/list/cancel, tick/daemon; fixed intervals, start/end, recipient, per-payment and total caps, finite runs, bounded retries for known unavailability, persisted history. Unknown or interrupted payment pauses the job instead of signing a new leaf. Reuse the existing payment client and agent runtime. Prove restart, cancellation, caps and retry policy.
6. **Integration (verified).** Update docs and test counts, run the complete repository gate plus E2E, inspect final diff and record rollout constraints. Backend deployment remains subject to the already identified missing environment and existing-data cutover; never reset an operational store.

## Verification

Each step has executable evidence in GATES.md. The previous maintenance ledger is archived at .unlazy/maintenance-2026-09-12/GATES.md. A passing gate proves its stated behavior, not a production deployment.

## Final evidence — 2026-09-13

All six GATES.md oracles passed with exit 0 and matching expectations: recovery (9 tests), atomic accounting (8), mined outcomes/wire semantics (3), real HTTP/Anvil process faults, scheduler (10), and the full repository check. The repository contains 980 TypeScript and 14 Foundry tests; all pass. The independent delegation negative-path suite also passed 23/23. Scheduler CLI add/list/runs/cancel was exercised across separate processes on an ephemeral SQLite file without runtime secrets. Final documentation/generated GitBook/count checks and git diff whitespace checks pass.

Implementation boundary: the Anvil recovery harness shares production HTTP routes, recovery and accounting, but uses native transfers and fixture validation; delegation/token authorization is covered separately by the real contract negative-path suite. The scheduler is a local CLI, with explicit time/spending conditions. External event triggers and compound task delegations remain future product work.

Rollout: these backend changes are implemented and locally verified, not deployed. Schema 6 refuses older stores without migration or reset. The existing operational DB, missing mini SSH/runtime environment and prior unresolved production prerequisites require a deliberate cutover. No operational DB or public-chain balance was changed. Previous working-tree edits and delegation-framework submodule dirt remain intact.
