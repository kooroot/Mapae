<!-- Generated file — do not edit. The source of truth is `docs/tech-notes.en.md`; regenerate with `bun run gitbook:build`. -->

# 4. Security considerations

## Facilitator trust boundary

The facilitator holds the relayer key, receives the signed `Payment-Signature`, and is
itself the redeemer the leaf pins. In other words, it sits in a position where every
identity check passes. The trust boundary is therefore defined not by whether the
facilitator is trusted, but by the **maximum damage when it is fully compromised**.

The crux is the signature scope of `redeemDelegations`. The permission context is signed,
but **the execution is not** — `_executionCallDatas` is supplied as calldata by the
caller at redemption time (`DelegationManager.sol:126-133`). A compromised facilitator
can submit an arbitrary execution alongside a valid leaf, and the only thing standing in
the way is the set of caveats attached to that leaf. The `wrong-redeemer` case does not
cover this threat — what that case proves is that a third party cannot redeem, and the
facilitator is not a third party.

| Attempt by a compromised facilitator | Refusing enforcer | On-chain revert |
|---|---|---|
| Pay its own address instead of the vendor | `AllowedCalldataEnforcer` | `invalid-calldata` |
| Inflate the amount (even within the period cap) | `ERC20TransferAmountEnforcer` | `allowance-exceeded` |
| Turn a one-shot payment into a standing allowance (`approve` drain) | `ERC20TransferAmountEnforcer` | `invalid-method` |
| Redirect the call to another contract | `ERC20TransferAmountEnforcer` | `invalid-contract` |
| Attach native value | `ValueLteEnforcer` | `value-too-high` |
| **Target the payer account itself** (entering the self branch) | `ERC20TransferAmountEnforcer` | `invalid-contract` |
| Redeem the same leaf again | `ERC20TransferAmountEnforcer` | `allowance-exceeded` |
| Redeem after expiry | `TimestampEnforcer` | `expired-delegation` |
| Accumulate beyond the period cap | `ERC20PeriodTransferEnforcer` | `transfer-amount-exceeded` |

The self-target case is the least obvious. Because execution happens through
`IDeleGatorCore(root.delegator).executeFromExecutor`
(`DelegationManager.sol:252-253`), an execution whose target is the payer account makes
the account call itself, and `msg.sender == address(this)` — the *self* branch of
`onlyEntryPointOrSelf` — holds (`DeleGatorCore.sol:106-109`). Through this branch lie
`withdrawDeposit`(:356), `enableDelegation`(:373 — undoes a revocation), and
`_authorizeUpgrade`(:526 — swaps the implementation). DeleGatorCore has nothing that
blocks a self call; the only thing standing in that spot is the caveat. The case uses
`withdrawDeposit(address,uint256)` as its payload because that calldata is exactly
68 bytes, so it passes the length gate of `ERC20TransferAmountEnforcer` (:87) and is
then caught by the contract check (:92) — making clear that it is not blocked by size
by accident.

The `approve` case is constructed to pass every address check — the pinned vendor
address goes into the spender slot. The only thing that refuses it is the selector
check, and it does refuse.

What remains available to a compromised facilitator is limited to the following.

- **Refusing to settle (liveness).** Funds are safe, but the payment does not proceed.
  The seller returns 504 `settlement_unknown` — an availability problem, not a safety
  problem.
- **Reordering and delay.** Within the expiry window.
- **Actually executing an amount the payer has already authorized, to the designated
  vendor.** Even if the seller never delivered the resource. A loss can occur, but the
  recipient is always the vendor the agent pinned and can never be the facilitator
  itself.

**Theft of funds, redirection, and exceeding the cap are impossible; what remains is
availability and ordering.** This is the rationale for a structure that entrusts the
relayer with gas but not with funds.

The nine rows in the table above are cases that `negative-path-suite.ts` executes, and
the six tampering cases carry a control — same leaf, same redeemer, an execution with
only the tampering removed settles normally. Without the controls, the six refusals
could also come from reasons unrelated to the tampering (an exhausted period, a stale
account). All cases pass on both a disposable chain and a GIWA fork.

The same public host as the facilitator also routes the onboarding sponsor under the
`/bootstrap` path — a separate process, a separate key. The request body is
`{permissionContext}` and nothing else, the owner is recovered from the signature, and
`CREATE2(owner)` must match the permission's delegator, so the caller cannot nominate
an address we would pay to deploy. Responses emit only a closed refusal enum. Even if
the sponsor key is compromised, all it yields is wasted gas up to the balance — holding
no delegation authority, it cannot reach payer funds, caps, or settlement. If the
sponsor coincides with the relayer or the deployer, the service refuses to boot:
sharing a key that answers unauthenticated requests with the settlement key lets
griefing spread into a settlement outage.

## Attack vectors and countermeasures

| Vector | Countermeasure |
|---|---|
| Signature replay | EIP-3009 nonce consumption (`authorizationState`), verified by tests |
| Smart-account signatures | OZ `SignatureChecker` — supports EOA and EIP-1271 alike. Bare `ecrecover` fails silently on 4337 accounts |
| Authorization front-running | An observer can submit `transferWithAuthorization` first, but funds move only to the signed `to` — an ordering issue, not theft. Use `receiveWithAuthorization` where logic depends on the fact of receipt |
| Validity window | `validAfter`/`validBefore` enforced. The L2 sequencer's timestamp manipulation margin (seconds) is negligible against the validity window (minutes to hours) |
| Relayer authority | Amount and recipient are fixed in the signature and cannot be changed |
| Signature exposure in logs | Facilitator error logs never record the signature or the full payload — only chain, asset, amount, address, and nonce metadata |
| Facilitator attack surface | The API is exposed only on loopback/private networks; the container image is pinned by digest with read-only, cap-drop, and no-new-privileges applied |
| Redirect hijacking | Payment requests from the agent and seller refuse HTTP redirects, so the authorization in the payment headers (`Payment-Signature`/`X-PAYMENT`) never travels to another origin |
| Malicious DelegationManager | Single-manager allowlist from the GIWA deployment artifacts; canonical EntryPoint and required enforcer addresses verified |
| Permission context exposure | Excluded from Git, size-limited, never printed in logs or error detail |
| Forged payer receipts | The canonical payer is derived from the last/root delegator in the `permissionContext`; a mismatched wire claim is refused |
| verify→settle race | Re-simulation immediately before settle |
| Duplicate settle | Deduplicated by a `paymentIntentId` over the canonical payment terms and the context bytes; the broadcast tx hash is stored before the receipt |
| Gas DoS via complex delegations | Estimate first, then refuse anything above the configured gas cap |
| Unauthorized relayer | The intersection of the leaf's `RedeemerEnforcer` and the 402's `facilitatorAddresses` is enforced |
| Onboarding griefing (repeated deploy requests) | Faucet window (one top-up per account per 24 hours) + daily gas budget + a small dedicated sponsor wallet — exhaustion stops only that day's onboarding and never touches settlement or funds |
| Nominating the deploy target address | The request body is `{permissionContext}` only — the owner is recovered from the signature, and the account is `CREATE2(owner)`, which must match the delegator |
| Non-canonical signatures (high-s, `v ∉ {27,28}`) | Deploy only after an offline canonical-form check — viem accepts them but OZ `ECDSA` reverts, so without the check we would pay to deploy an account whose every grant reverts |
| Vulnerable dependencies | `bun audit` runs in the gate. Every finding is either fixed or accepted with a re-measurable proof attached |

## Acceptance criteria for dependency advisories

A finding reported by `bun audit` is either fixed or explicitly accepted with a
rationale attached. Nothing is accepted today.

The basis for an acceptance is code, not prose. Each accepted item in
`scripts/check-advisories.ts` carries a `prove` function that re-measures its own claim
on every run, and there are three failure directions — a new finding that is not
accepted, an acceptance whose proof has broken, and an acceptance that is no longer
reported (an unused exception outlives its rationale). A run that cannot reach the
registry is distinguished from zero findings — in that case it prints that the
comparison was skipped, and the `prove` functions still run offline as-is.

The third direction has fired for real. We were accepting the Windows path traversal
(moderate) in `@hono/node-server <2.0.5`, and the advisory was later revised into two
affected ranges — `< 1.19.15` and `>= 2.0.0, < 2.0.5`. The fix had been backported to
1.x, and the lockfile already resolved that same 1.19.15, so there was nothing left to
accept and the entry was deleted. The acceptance text had said "the final 1.x is
1.19.15", which was true; what could not be known at the time was that this 1.19.15
*was* the backport.

## The MCP server is stdio-only

The proof that acceptance carried did not disappear with the advisory. It now stands on
its own as `scripts/check-mcp-stdio.ts`, because the property it proves never depended
on the advisory: `apps/agent-mcp` speaks stdio and opens no HTTP listener. That is a
design property, not an accident, nothing in the code says so out loud, and one `import`
line breaks it.

The gate bundles the entrypoint and checks that references to the HTTP adapter are zero.
Since its entire output is an absence, a detector that always returns zero — a renamed
package, a bundler that minifies the string away, a silently failing build — would pass
while proving nothing. So the control is measured first:
`apps/agent-mcp/http-transport-control.ts` imports on purpose the transport the real
server does not, and only after the references are found there (measured 3 versus 0) is
the entrypoint's zero trusted.

## Logging and credentials

viem embeds the full transport URL in its error messages, and on an RPC endpoint that
carries its API key in the path, the URL itself is a credential. `redactUrls` in
`packages/shared` reduces any URL that reaches a log to `scheme://host`, and the
`check:logging` gate refuses, repository-wide, any code where a raw error reaches a
`console.*` argument. Signed payloads and permission contexts are bearer authorizations
and are never printed in logs or error detail.
