<!-- Generated file — do not edit. The source of truth is `docs/tech-notes.en.md`; regenerate with `bun run gitbook:build`. -->

# 6. Verification status and roadmap

This records what has been verified, and to what level, together with the grade
of evidence. By the same rule as the §2 evidence table, what was mined, what
completed on a fork, and what was confirmed by simulation are never mixed in
the same sentence.

- **Delegated payment pipeline — mined on GIWA** — the Framework deployment,
  the owner account deployment, the root delegation signature (verified through
  ERC-1271), and a normal settlement are all mined on GIWA. The cap and expiry
  refusals are simulations against current GIWA state, not mined transactions
  (§2 evidence table)
- **Agent automation — mined on GIWA** — `0x533c…9964c`, a settlement executed
  by a single MCP tool call with no human step, was mined at block 31634935,
  and the payer's gas spend is `0`
- **Sponsored onboarding — mined on GIWA** — account `0x15286FE9…3301` was
  sponsor-deployed from the owner recovered out of a pre-deployment signature
  (`0xed21ac71…9902`), 3 mUSDC was minted (`0x9d14588b…baa0`), and live
  ERC-1271 answered `0x1626ba7e` to that prior signature. The new user's gas
  spend is `0`. The service itself is verified by 15 cases on a GIWA fork
  (`test:e2e:bootstrap`)
- **Negative-path suite — ephemeral chain and GIWA fork** —
  `negative-path-suite.ts` runs the same case set (normal, period cap, period
  reset, expiry, wrong-redeemer, recipient mismatch, replay, 6
  facilitator-tampering cases plus a control, payer mismatch, root revocation,
  4 revocation-UserOp cases, 2 submission-endpoint cases, manager
  aggregation) on both an ephemeral chain and a GIWA fork through chain
  parameterization, and checks each case down to its on-chain revert reason.
  The suite counts and prints the case count itself
- **Revocation submission endpoint — GIWA fork + 1 live run** — on a fork
  pinned to real GIWA state and deployed bytecode, the submitter E2E and an
  EntryPoint revocation completed end to end, including the browser CORS leg,
  and on 2026-08-04 **the first live revocation was mined on GIWA** through
  the public sponsored path — also a run in which a real person passed the
  wallet (MetaMask) approval screen. Pre-funding on the self-funded
  (pinned-mode) path still remains the owner's responsibility
- **Standing gates — local + GIWA read-only** — `bun run check`, which bundles
  the type, test, docs, and dependency gates, passes in full. The Framework is
  re-verified 38/38 against runtime bytecode and deterministic addresses.
  Explorer source verification stands at 38 of 39 (38 units + MockUSDC); the
  single unverified unit does not match current source due to a MetaMask SDK
  artifact/source revision difference and is not used on any Mapae policy path
  (detailed evidence in [Deployed contracts](../../deployed-contracts.md))
- **Numeric discipline on the public web** — the figures the public web
  (`apps/web`) displays are restricted to three sources: direct chain reads,
  mined hashes, and revert reasons checked by the negative-path suite

To be built:

- **Settlement brain** — triggers and schedulers, compound delegations
  (recipient, period, cap), a ledger, retries
- **KYC and attestation verification path** — Dojang KYC gate + EAS
  contract/receipt schemas + resolvers
- **Fulfillment verification** — an optimistic structure (default pass,
  challenge window, bond). Designed on the premise that it is not trustless,
  because the final adjudicator is arbitration rather than re-execution
