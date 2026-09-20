<!-- Generated file — do not edit. The source of truth is `docs/tech-notes.en.md`; regenerate with `bun run gitbook:build`. -->

# 3. Error model

A discriminated union that assigns a tag to every failure mode on the settlement
path (`packages/shared/src/errors.ts`).

Blockchain code has a wide error surface — RPC timeouts, rate limits, reverts,
nonce contention, signature verification failures, relayer gas exhaustion.
Collapsing these into a single `catch` destroys the information recovery needs.
Each tag distinguishes:

- **Retryable** (`RpcUnavailable`, `RpcRateLimited`) — retry after backoff
- **Operational failure** (`RelayerOutOfGas` and the like) — 503, not the caller's fault, alert-worthy
- **Caller error** (`InvalidSignature`, `DomainMismatch`, `MalformedPayload`) — 4xx, the cause is returned

Why `DomainMismatch` is its own tag: an EIP-712 domain mismatch is the most
common failure in an x402 integration, and if it goes out as a generic 500 the
cause cannot be pinpointed.

**The two paths have different response policies (deliberately).** It is the
EIP-3009 direct payment's error model (`SettlementError` in `packages/shared`) that
carries the tag union verbatim in the response body. The app that issued that path is
gone; the model and its tests remain. The ERC-7710 delegated path behaves differently.

| | Direct payment (`packages/shared` error model) | Delegated payment (`apps/delegated-seller`, `apps/facilitator-erc7710`) |
|---|---|---|
| External response | `SettlementError._tag` + `describe()` cause | x402 v2 §9's **closed words** — `invalid_payload`, `settlement_pending` and the rest, plus `delegation_rejected` from outside §9. The reason's sentence never goes out |
| Status code | `httpStatusFor()` | 402 / 400 / 403 / 422 / 504 |
| Client branching | Tag | `DelegatedPaymentFailureCode` (the agent's own classification) |

The delegated path sends out words only because of the threat model. Returning
failure reasons as sentences would let an attacker probe the caveat boundaries —
remaining allowance, expiry status, re-delegation structure — from responses alone. The
cause goes to the server log. `redactForLog` keeps the revert reason
(`ERC20PeriodTransferEnforcer:transfer-amount-exceeded`) and removes the
bearer-length hex viem embeds in the error (the signed permission context),
leaving only its size. The operator sees the cause; the caller does not.

## The refusal words are §9's

A facilitator refusal formed before the broadcast comes out of one classification
(`describeFailure`), and every word of it but `delegation_rejected` is from the x402 v2 §9
vocabulary. `/verify`'s `invalidReason`, `/settle`'s `errorReason` and the `errorCode` on
the `rejected` row `/settle` writes to the ledger are that one value, so the reason a
buyer is given and the code an operator counts can never disagree. A result that failed
after it was mined (`settlement_reverted`, `vendor_not_credited`) does not pass through
that classification — the journal writes it onto the terminal row from the receipt, and
`/settle` carries that row verbatim (last line of the table below).

| Word | What produces it |
|---|---|
| `invalid_x402_version` | `x402Version` on the request or the payload is not 2 |
| `invalid_payload` | Something the request says about itself is wrong — not an object, a body that cannot be read (content-type, size, `JSON.parse`), a missing `paymentPayload`/`paymentRequirements`/`accepted`/`payload`, an `accepted` that is not exactly the seller's offer, a `delegationManager` that is not allowlisted, the shape/decoding/root delegator of `delegator` and `permissionContext`, a claimed delegator that is not the signed root payer |
| `invalid_payment_requirements` | The offer's own terms — asset, `payTo`, `maxTimeoutSeconds` (1–300), `amount`, the safety cap, this facilitator not being advertised as a redeemer |
| `unsupported_scheme` | `scheme` is not `exact`, or `extra.assetTransferMethod` is not `erc7710` |
| `invalid_network` | A chain that is not GIWA Sepolia |
| `invalid_transaction_state` | `/verify` only — this payment's settlement already ended on chain as a failure (a mined revert, a receipt with no `Transfer` to the seller). Re-simulating cannot make it valid |
| `settlement_pending` | `/settle` only — the original transaction exists and its result is unknown. Always with a non-empty `transaction` |
| `unexpected_verify_error` / `unexpected_settle_error` | An exception that is none of the above — a defect of ours. It threw before the broadcast, so nobody was charged, but nothing about it is a verdict on the delegation either |
| `settlement_reverted` / `vendor_not_credited` | Not a refusal but a mined terminal result — the journal produces it from the receipt, not `describeFailure`, and the gas is already spent |

`delegation_rejected` is the one refusal word outside §9, and its definition is narrow for
that reason: the facilitator examined the delegation against live state and the chain
refused to redeem it — a decoded simulation revert (including the `ExecutionRevertedError`
shape a node reports under a plain `-32000`, leaving viem no revert data to decode), or gas
above `MAX_REDEMPTION_GAS`. It is not "any viem error": another viem error, such as an
encoding mistake of ours, is `unexpected_*_error` — the facilitator does not call a grant
the chain never saw a rejected one. The last call on sending a buyer back to re-sign
belongs to the seller's ladder, and its `decideVerification` still reads every `/verify`
`invalidReason` but `rate_limited` and `facilitator_not_ready` as `rejected` (a 403
`delegation_rejected`); telling `unexpected_verify_error` and `invalid_transaction_state`
apart is work left on the seller SDK. `budget_exhausted` and `payer_budget_exhausted`, the
day's gas budget, are outside §9 too: what refused was our relayer's day, not the
delegation. `rate_limited`
and `facilitator_not_ready` are not refusals at all but "the request was never looked at",
and the seller's ladder reads them as 503.

## How absent state is judged

One rule applies across the guard code: **a value that could not be read, or
does not exist, placed in a judgment position must produce a refusal or a
distinct reason — never satisfaction.**

- **`PERMISSION_EMPTY`.** The correct ABI encoding of an empty `Delegation[]` is
  a 130-character string that passes the hex-shape guard, and `decodeDelegations`
  turns it back into `[]`. In that state every pre-flight check would pass for
  lack of anything to compare against, so it is refused under its own tag.
  `PERMISSION_INACTIVE` is not reused because the two tags direct different
  actions — the former means regenerate the artifact, the latter means check the
  chain for revocation or expiry. The guard sits in both places: boot validation
  (`loadDelegatedAgentRuntime`) and the judgment function
  (`judgePreflight`).
- **Absent period caveat.** If the link carries no `ERC20PeriodTransferEnforcer`
  caveat, the remaining balance stays `undefined`. Two consumers judge that
  state differently because they ask different questions.

| | Question | `tightest === undefined` |
|---|---|---|
| `judgePreflight` (runtime) | Will the chain refuse this payment? | Pass — without a cap it is not refused |
| `giwa-preflight` (human gate) | Does the configuration match the intent? | Fail — there is no value to check against |

  The computation (`tightestPeriodRemaining`) is shared in
  `packages/delegation`; each side keeps its own judgment, and the two are
  linked by cross-reference comments.
- **Absent input to the fee judgment.** `judgeSubmissionReadiness` refuses the
  state where the base fee could not be read as `base_fee_unreadable`. The
  reason is kept separate from `fee_below_basefee` because the two direct
  opposite actions — `fee_below_basefee` tells the owner to re-sign with a
  higher fee, `base_fee_unreadable` says retry the chain read.

## Standing gates

`bun run check` mechanically verifies the claims of documentation and
configuration alongside the code. Every gate runs without keys or network, and
gives the same result on a clean clone.

| Gate | What it verifies |
|---|---|
| `check:docs` | That every `bun run` and `make` command in the documentation actually exists, that every relative link resolves, and that every address matches the deployment artifacts and the canonical token source |
| `check:gitbook` | That the GitBook chapters, SUMMARY, and configuration match, byte for byte, what is derived from the canonical source (`docs/tech-notes.md`) |
| `check:logging` | That no raw error reaches a `console.*` argument in `apps/`, `packages/`, or `scripts/` — viem embeds the transport URL in error messages, so this blocks the path by which an RPC URL with a key in its path leaks into logs |
| `check:storage` | That no browser-storage **write** anywhere in `apps/web/src` happens outside the one sanctioned module (`lib/grant-store.ts`) — that module's projection is an allowlist which omits the agent session key, and a second write elsewhere would inherit neither the allowlist nor the test that pins it. Reads and removals are allowed everywhere |
| `check:mcp-stdio` | That the MCP server's entrypoint bundle reaches no HTTP adapter — the zero is trusted only after the references are found in a control first. Since the output is an absence, a detector that always returns zero *is* the fail-open |
| `check:advisories` | That every `bun audit` finding is either fixed or an acceptance carrying a `prove` function that is re-measured on every run |
| `check:counts` | That the test counts the repository README states match what bun and forge actually collect — it checks agreement with the suites, not agreement among the numbers in the documentation |

## The semantic distinction between 422 and 504

Among the opaque reasons, these two must be distinguished. `settlement_failed`
(422) means "the payer was not charged"; `settlement_unknown` (504) means
"whether the payer was charged could not be established." The former is an
answer that invites a retry, and retrying an unconfirmed state becomes a double
payment.

The distinction is grounded in a real incident. GIWA `0x533c5cb2…9964c`
(block 31634935) actually transferred 1.00 mUSDC from the payer, yet the caller
received `PAYMENT_REJECTED` — the receipt-wait timeout had been configured
longer than the seller's HTTP timeout. The timeout budgets were then redesigned
to grow toward the outer layers (25 → 35 → 45 → 50 s), and a payment whose
outcome is unresolved is returned as `SETTLEMENT_UNKNOWN`.

The judgment is isolated in a pure function, `decideSettlement()`
(`packages/delegation/src/facilitator-contract.ts`), and the criterion string
(`SETTLEMENT_PENDING`) and the response type are taken from the same module
by producer and consumer alike. The decision ladder leans toward `unknown`.

| Observation | Result | Reason |
|---|---|---|
| No response received (connection refused, non-2xx, not JSON, timeout) | `unknown` 504 | "The request never arrived" and "the response was lost after broadcast" cannot be told apart |
| `errorReason === SETTLEMENT_PENDING` | `unknown` 504 (+hash) | x402 v2 binds this reason to a hash — without it the caller has no way to verify |
| `success !== true` | `failed` 422 | Explicit refusal — no funds moved |
| `success === true`, payer mismatch | `unknown` 504 | A broadcast was claimed but the identity did not line up, and the balance was not confirmed |
| `success === true`, payer match | `settled` 200 | |

`transaction` is on every `/settle` response — the broadcast hash, or `""` when nothing
was broadcast. That is the shape x402 v2 requires, and `settlement_pending` cannot go out
without the mandatory hash.

`replayed: true` means "this call is not the one that produced the answer it carries":
either a journal row for the payment already existed when the call began (a resumed claim
re-sends the very bytes that row already named, so the hash is the same — not a second
transaction), or the call was coalesced into a concurrent call's operation and handed that
operation's answer. At most one answer per payment is therefore unmarked. It is not a
delivery gate on its own: when a first attempt ends `settlement_pending` and a later call
finishes that claim, every successful answer is marked. A seller dedupes on its own record
of the payment intent id and reads this flag as exactly what it says — "some other call
did this".

This path can be forced on a fork — shrinking the facilitator's receipt wait to
1ms exercises the unconfirmed-after-broadcast branch.

```bash
cd apps/delegation-lab && SETTLEMENT_RECEIPT_TIMEOUT_MS=1 bun run test:e2e:mcp
```

The run does not only check status codes; it reads the enforcer events directly
from the fork and cross-checks whether funds actually moved.

## Effect migration plan

The current implementation is a discriminated union, with the `_tag`
discriminator kept isomorphic to [Effect](https://effect.website)'s
`Data.TaggedError`.

| Stage | State |
|---|---|
| Now | Discriminated union + explicit branching. Every failure mode enumerated at the type level |
| Next | Migrate the settlement path to `Effect<A, SettlementError, R>` — typed error channel, `Schedule`-based retry/backoff, resource-safe RPC connections |

It was not adopted during the MVP window because partial adoption is hard.
Effect propagates through the entire call chain, so adopting it before the core
payment loop was proven would have been an execution risk. Fixing the shape of
the error model first turns the migration into a mechanical substitution rather
than a rewrite.
