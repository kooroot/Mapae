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
| External response | `SettlementError._tag` + `describe()` cause | x402 v2 §9's **closed words** — `invalid_payload`, `settlement_pending` and the rest, plus `delegation_rejected` from outside §9. The reason's sentence never goes out. The seller puts that word in a failing answer's `Payment-Response` (the x402 v2 `SettleResponse`) |
| Status code | `httpStatusFor()` | 402 / 400 / 503 / 502 / 504 |
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
| `unexpected_verify_error` / `unexpected_settle_error` | An exception that is none of the above — a defect of ours. It threw before the broadcast, so nobody was charged, but nothing about it is a verdict on the delegation either. The seller reads the first as a 503 (no verdict) and the second as a 504 (unknown): the word does not say where in the sequence the failure happened, so a seller pointed at some other facilitator cannot claim from it that nobody was charged |
| `settlement_reverted` / `vendor_not_credited` | Not a refusal but a mined terminal result — the journal produces it from the receipt, not `describeFailure`, and the gas is already spent |

`delegation_rejected` is the one refusal word outside §9, and its definition is narrow for
that reason: the facilitator examined the delegation against live state and the chain
refused to redeem it — a decoded simulation revert (including the `ExecutionRevertedError`
shape a node reports under a plain `-32000`, leaving viem no revert data to decode), or gas
above `MAX_REDEMPTION_GAS`. It is not "any viem error": another viem error, such as an
encoding mistake of ours, is `unexpected_*_error` — the facilitator does not call a grant
the chain never saw a rejected one. The last call on sending a buyer back to re-sign
belongs to the seller's ladder, and its `decideVerification` reads a `/verify`
`invalidReason` three ways: `rate_limited`, `facilitator_not_ready` and
`unexpected_verify_error` are not verdicts but "there is no verdict", so `unavailable`
(503); everything else is `rejected` (402 with the offer re-issued); and the word that
rides along is the facilitator's only when it is in the allow-set — anything outside folds
to `delegation_rejected`. `unexpected_verify_error` is a 503 because it is a throw of ours
before the broadcast: nobody was charged *and* nothing about the delegation was decided, so
reading it as a refusal would send the buyer to re-sign a grant nothing refused.
`invalid_transaction_state` stays a refusal: the same leaf cannot buy again, but a new
payment can, which is what 402 says. The four words that name a defect in the request's own
text (`unsupported_scheme`, `invalid_network`, `invalid_payment_requirements`,
`invalid_x402_version`) are answered with that same 402, which is chosen rather than an
oversight of the spec's 400 mapping: 400 is this profile's answer to a payment it could not
*read*, and a payload that parsed but disagrees with the offer is fixed by reading the offer
that comes back with the 402 — precisely what a buyer who signed against a stale or misread
offer needs. `budget_exhausted` and `payer_budget_exhausted`, the
day's gas budget, are outside §9 too: what refused was our relayer's day, not the
delegation.

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

## The seller's ladder — a failure that charged nobody, and one nobody confirmed

Among the opaque reasons, these two must be distinguished. "The payer was not charged" is
an answer that may be paid again; retrying "whether the payer was charged could not be
established" becomes a double payment. The seller's ladder says which in its status code.

| Status | When | Offer re-issued? | Receipt |
|---|---|---|---|
| `400 malformed_payment` | the header is oversized, unparseable, not ERC-7710, or carries a `payment-identifier` of the wrong shape | No — what to fix is inside the header | `invalid_payload`, `transaction: ""`, and the payer only when the header itself parsed |
| `409 payment_identifier_conflict` | the same `payment-identifier` under a different fingerprint (another resource, price or method), or a different leaf under an id that has not settled | No — every payment under this id gets the same answer | that word and the payer, `transaction: ""`. Nothing was charged for this request |
| `409 payment_identifier_settled` | the same fingerprint with a different leaf, under an id that already settled | No — that name has already paid | that word, the **stored** payer, and the hash when there is one |
| `503 facilitator_unavailable` | `/supported` out of reach; `/verify` or `/settle` answered `rate_limited` or `facilitator_not_ready`; `/verify` answered `unexpected_verify_error` | No — the same payment may be presented again later | that word and the payer — except for a request that sent no header at all, which gets none |
| `402` + offer | `/verify` refused, or a `/settle` failure that charged nobody (a budget word, and `settlement_reverted` even with a hash — a mined revert moved no asset) | **Yes** — a new leaf can pay | that word and the payer |
| `504 settlement_unknown` | the `/settle` outcome is unknown: answer lost, `settlement_pending`, `unexpected_settle_error`, payer mismatch, and **a failure that names a hash under a word that is not a mined-failure word** | No — the buyer may be charged | `settlement_pending`, the payer, and the hash when there is one |
| `502 settlement_misdirected` | `vendor_not_credited` — mined, and it credited someone who is not this `payTo` | No — the balance has already moved | `vendor_not_credited`, the payer, the hash |

Every refusal that *read* the payment header carries the x402 v2 `SettleResponse` in
`Payment-Response`: `success: false`, `network`, one §9 word, and the payer where it is
known. The hash rides along whenever there is one (`settlement_pending` on the 504,
`vendor_not_credited` on the 502) — it is the buyer's only way to find out for themselves.

A success receipt and a failure receipt are shaped differently, which is why the type is a
union discriminated on `success` (`packages/shared/src/x402.ts`): `payer` is required of a
success and may be omitted only on a failure — money that moved cannot fail to name who paid
it, but a 400 answering a header it could not read lost the name inside it. The same 400
does name the payer when the header parsed and only the identifier it carried was malformed.
`errorReason` is the mirror image, required of a failure. The reference implementation leaves
all three optional; this profile always holds a word folded onto a closed vocabulary before
it answers, so leaving `errorReason` optional would put "a failure receipt with no reason" —
a state nothing here produces — into the type.

Words and rungs are not one to one. `invalid_payload` is the word the seller reaches on its
own for a header it could not read, on the 400, and it is also what the facilitator answers
for an `accepted` block that disagrees with the offer or a delegator that is not the signed
root — which passes straight through `KNOWN_REFUSAL_REASONS` and arrives as a 402 with a
payer. Read the rung off the status, never off the word.

Two answers carry no receipt. A request that sent no payment header: that request asked what
the resource costs rather than paying for it, and a receipt for a payment nobody made is an
invention. And the 404, the rung the paywall leaves before it reads the header, so a request
that did carry a payment gets none either. That is the rung's own rule rather than an
exception to this one: no route would have served the payment, so nothing priced it, and a
receipt for a payment nothing priced is the same invention. Every answer also carries
`Cache-Control: no-store` and `Vary:
Payment-Signature`, so no shared cache hands a paid body to a request that did not pay, or an
unpaid 402 to one that did.

The agent side reads those words to classify its failure (`payment-client.ts`). When a retry
is not 2xx, only the **header** is read — never the body, which a seller can reflect a
bearer header into — and of the header only two fields: `errorReason` when it matches our own
constants as a closed set, and `transaction` when it has the shape of a hex hash.
`settlement_pending` and `unexpected_settle_error` → `SETTLEMENT_UNKNOWN`; `rate_limited`,
`facilitator_not_ready` and `unexpected_verify_error` → `SELLER_UNAVAILABLE`; the remaining §9
words and `delegation_rejected` → `PAYMENT_REJECTED`.

What a word may do has a direction: it can make this end *more* careful than the status, never
less. `settlement_pending` lifts a 402 to the 504 reading, but no word overturns a status in
`SETTLEMENT_UNKNOWN_STATUSES` (504, 502, 52x) — that set is the reading the GIWA incident below
bought, and the incident arrived as a status. The hash is the same rule read off the receipt:
a failure receipt that names one means something was broadcast, so the code is
`SETTLEMENT_UNKNOWN` whatever the word claimed, and that hash travels on in `detail` — it is
the only value the caller can take to an explorer. A word outside the set changes nothing and
the status rules decide — `vendor_not_credited` and `settlement_reverted` are why that
protection exists: they are the two mined-failure words, they arrive with a hash the rule above
already reads, and admitting either as one more §9-shaped refusal would turn that into
"nothing happened, pay again".

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
| `errorReason === unexpected_settle_error` | `unknown` 504 (+hash) | The word does not say where in the sequence it happened — an answer that cannot say whether it broadcast cannot claim nobody was charged |
| `success !== true`, `errorReason === vendor_not_credited` | `failed` 502 (+hash) | Mined, and it credited somewhere that is not our `payTo` — the balance may have moved, so no offer is re-issued |
| `success !== true`, a hash is named and the word is not a mined failure (`settlement_reverted`, `vendor_not_credited`) | `unknown` 504 (+hash) | The hash outranks the word. Every word that reaches `failed` claims a refusal formed before any broadcast (the folded `delegation_rejected` included) and the hash says something went out anyway — believing the word answers "pay again" while holding the evidence |
| `success !== true`, otherwise | `failed` 402 + offer | Explicit refusal — no funds moved, and a new leaf can pay |
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
