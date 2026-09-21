# Mapae — Technical notes

> The Mapae was not a token of privilege but a token of limits.
> The engraved horse count was not the authority granted — it was where that authority ended.

Infrastructure on GIWA Chain where an agent executes settlement **within a delegated limit** and leaves that execution as a verifiable record.

**This file is the source of truth.** The GitBook rendering (`docs/SUMMARY.md` + `docs/tech/`) is
generated from this file by `bun run gitbook:build`, and the drift
gate in `bun run check` refuses any mismatch between the generated output and the source.

---

## 1. System architecture

| Component | Role | Runtime |
|---|---|---|
| `contracts/` | MockUSDC (EIP-3009) | Solidity 0.8.28 / Foundry |
| `facilitator/` | x402 payment verification and settlement broadcast | x402-rs (Rust, operated as a container) |
| `packages/shared` | Chain, token, x402 types, error model | TypeScript |
| `packages/delegation` | Framework environment, caveats, signing, re-delegation, revocation, ERC-7710 | Smart Accounts Kit 1.7 |
| `apps/facilitator-erc7710` | ERC-7710 verify/settle adapter | Bun + viem |
| `apps/delegated-agent` | Builds a payment-specific leaf from a parent delegation | Bun |
| `apps/delegated-seller` | ERC-7710 hosted shop — shop manifests, paywalled tickets, the orders ledger | Bun + Hono |
| `apps/agent-mcp` | Exposes the payment loop as an MCP tool | Bun + MCP SDK (stdio) |
| `apps/payment-scheduler` | Buys the same seller resource at a fixed interval — slots, budget, run history and retries live in a DB, and each claim is one payment | Bun + SQLite (`@mapae/store`) |
| `apps/revocation-submitter` | Receives an owner-signed revocation UserOp → `handleOps` — two modes: pinned (single payer, loopback) / sponsored (public, sponsor-funded deposit) | Bun + Hono |
| `apps/account-bootstrap` | Recovers the owner from a pre-deployment signature → sponsored CREATE2 deploy of the payer account + mUSDC mint | Bun + Hono |
| `apps/delegation-lab` | Deployment previews, negative-path and e2e suites, fork orchestration | Bun |
| `apps/web` | Public landing + Studio (sponsored onboarding; grant, inspect, and revoke a delegation) | TanStack Start + Cloudflare |

**Language rationale** — The delegation layer depends on MetaMask Smart
Accounts Kit (formerly Delegation Toolkit), the ERC-7710/7715 TS SDK, which is
TypeScript-only, so the application layer is TS. The on-chain Delegation
Framework contracts are a separate artifact from that SDK, deployed on GIWA.
The facilitator's position is to **operate** the x402-rs container rather than
implement its own.

---

## 2. Payment flows

Mapae's payment path is the ERC-7710 delegated payment. EIP-3009 direct payment, the
first regression path, has lost its apps (a seller and an agent) and kept only its
primitives.

### EIP-3009 direct payment — what remains

MockUSDC in `contracts/` implements `transferWithAuthorization`; `packages/shared`
holds the authorization's types, its EIP-712 domain and the settlement error model
(`SettlementError`); `facilitator/` is the x402-rs container configuration. The two
apps that issued and paid this path were removed when the hosted shop arrived — the
delegated path closes the same 402 → sign → settle loop under narrower authority.

One property was kept as the delegated path's starting point: the authorization
pins `from`, `to`, and `value` under the signature, so the relayer that broadcasts it
holds no authority beyond that of a broadcaster. The payer pays no gas.

### ERC-7710 delegated payment

```text
account owner wallet → HybridDeleGator owner account
            (if the account does not exist yet: pre-deployment signature → account-bootstrap deploys with sponsor gas)
            → erc20PeriodTransfer parent delegation
agent       → receives 402
            → signs a payment-specific leaf with amount/payTo/facilitator pinned
seller      → ERC-7710 facilitator /verify → /settle
facilitator → DelegationManager.redeemDelegations
            → mUSDC.transfer(payTo, amount)
```

In this document, permission and delegation refer to the same signed artifact — the
difference is ERC-7715 versus ERC-7710 terminology. The parent caveat enforces the
60-second period cap and the expiry window (30 minutes by default, extended via
`PERMISSION_TTL_SECONDS` for the demo) on-chain. The vendor profile also pins the
recipient position in the ERC-20 `transfer` calldata. In manager-to-child
re-delegation, the child's individual cap and the manager's aggregate cap apply
simultaneously.

**The offer's `extra`.** An ERC-7710 offer's `extra` always carries two fields, plus two
more when the facilitator advertises them. Always present:
`assetTransferMethod: "erc7710"` (exact-EVM's official transfer method) and
`paymentFlow: "upfront"`. The latter is the declaration §6.1 of the specification
requires: any flow other than the default `authorization` MUST be declared, and Mapae
hands over the resource only after `/verify` **and** `/settle` have both succeeded.
Without the declaration a client reading the specification assumes `authorization`
— served first, settled after — and computes the wrong moment of delivery. The two
conditional fields are `facilitatorAddresses` (the trust gate — the agent refuses any
offer that does not overlap its own allowlist) and `delegationManager` (GIWA's manager is
in no registry, so the in-band advertisement is the only channel a third-party integrator
has); the middleware copies both verbatim from `/supported`. Every offer this repo builds
declares the flow, down to the `/supported` kind.

**The reading side accepts the default flow in three shapes.** Two flows are payable —
this rail's `upfront` and the specification's default `authorization` — and both an absent
declaration and an explicit `null` mean that default (the reference schemas in
`@x402/core` 2.20.0 fold a null optional field into absence with `.nullish()`).
`authorization` has the seller serve first and settle after, so the seller carries the
settlement risk itself and nothing changes about what a one-shot leaf our agent signs can
lose. Splitting payment from refusal on whether the field was written would make the test
"did you spell it out?" rather than "which flow is it?", and would kill only the sellers
who declared the same flow honestly. Absence is also what a real counterparty produces:
the supportedKind flow in `@metamask/x402` 0.2.0 copies only `facilitatorAddresses` out of
`/supported`'s `extra`, so an offer built that way declares no flow at all (a measurement
the conformance test pins). `escrow`, by contrast, is a different flow — a later claim —
that this client's result cannot describe, so it is refused together with any unknown
value.

**The facilitator applies the same rule.** This rail settles in place — `/settle` follows
`/verify` and redeems there — so there is no code that could perform `escrow`, and such an
offer is refused as `invalid_payment_requirements` even when the offer and its echo agree.
Were the protection on the client alone, we would settle on the spot a payment the seller
declared as a later claim. `paymentFlow` is also part of the echo comparison: our seller's
offers always carry the value, so a payload that drops or rewrites the field accepted
terms other than the ones offered, and is `invalid_payload`.

**The 402's `extensions` is an envelope.** In the specification `extensions` is a map
from extension name to `{info, schema}` — `info` is what the extension itself declares,
`schema` a JSON Schema describing the shape a client echoes back in its payload. The
hosted shop publishes one entry, `mapae`, and puts the seller and the manifest URL under
its `info`. There is no `schema`: nothing there asks the client to echo anything. The
payment **payload** carries a slot of the same name. The specification has a client echo
only the extensions it actually *used*, and the first producer of that slot here is
`payment-identifier`, below. The reference client
is looser than that rule — `mergeExtensions` in `@x402/core` 2.20.0 returns the seller's
whole map when the client adds nothing of its own, so a reference-stack payer paying the
hosted shop echoes the `mapae` entry back unused. The facilitator's validator compares the
fields it names instead of enumerating the object's keys, so that entry is ignored rather
than refused. `/supported`'s identically named `extensions` is a different thing: the
**list** of extensions the facilitator supports, which today is empty.

**`payment-identifier` is an idempotency key, not authentication.** Give the paywall a
binding store and the 402 advertises this extension; the client then puts a fresh id
(`pay_` plus 16 random bytes in hex) in its payload envelope, one per payment. **Before**
settling, the seller binds that id to the request fingerprint — scheme, network, asset,
amount, payTo, resource URL and method folded with sha256 — and to the payment intent. The
resource URL includes the origin and the query: fold the path alone and a header paid at
`/report?ticker=A` is served the stored receipt at `?ticker=B`, one settlement for two
resources. It is also where the spec says to scope the key by tenant, merchant or route.
The reason any of this is needed is that a retry signs a **new leaf**: the intent differs,
so neither the facilitator's intent journal nor the shop's orders table can see the two
attempts as one payment, and the identifier is the only name that spans them. That name is
not signed, though — a man in the middle can rewrite it — so it is an idempotency hint and
never authentication, and every safety decision is still made alongside the
signature-derived intent. A seller that supplies no binding neither advertises the
extension nor reads an id that arrives: promise only what you can keep.

There are four verdicts. An unseen id settles the usual way. The same request and the same
leaf under an id that already settled is answered from the stored payer and hash **without
settling again** (`replayed` on the success receipt says this call did no settling). A
different fingerprint is `409 payment_identifier_conflict`: nothing was charged for this
request, so a fresh id is how to pay. The same fingerprint with a different leaf, under an
id that already settled, is `409 payment_identifier_settled`, and that one carries the
stored payer and hash — it is where a buyer whose first attempt ended `settlement_pending`
arrives after signing again, and "nothing was charged" would be the sentence that makes
them pay twice. The buyer's client reads the first word as `PAYMENT_REJECTED` and the
second as `SETTLEMENT_UNKNOWN` for that reason.

The hosted shop keeps two tables because it asks two questions: `orders` answers "what was
sold" once money has moved, and `payment_identifiers` answers "is this the same payment"
from the first attempt onwards. A row there is written **before** the facilitator is asked
anything, so attempts nobody verified claim one too — which is why it carries the same kind
of prune the ledger's refusals do: unsettled rows only, bounded by both an age and a count.
Settled rows are the replay guard and are never touched. The table took the store schema to
version 7, and this build refuses an older file rather than migrating it: an operator moves
the existing sqlite file aside and re-seeds, which recreates sellers, items, orders and
tickets.

The sequence below shows three paths for one and the same delegation — a normal
settlement, an over-cap refusal, and an expiry refusal. What decides a refusal is
the on-chain caveat, not a backend.

```mermaid
sequenceDiagram
    autonumber
    actor Owner as Owner wallet
    participant SA as HybridDeleGator<br/>smart account (payer)
    participant Agent as delegated-agent<br/>session key
    participant Seller as delegated-seller
    participant Fac as facilitator<br/>(relayer, pays gas)
    participant DM as DelegationManager<br/>+ caveat enforcers
    participant USDC as MockUSDC

    Note over Owner,SA: once, up front — root delegation signed offline<br/>a pre-deployment signature is also valid ('Sponsored onboarding' below)
    Owner->>SA: eth_signTypedData_v4 → ERC-1271 0x1626ba7e
    Note right of SA: 3 mUSDC / 60s cap · expiry window · permission.json

    rect rgb(232,245,233)
    Note over Agent,USDC: ① normal path — cumulative 2.5 ≤ 3.0
    Agent->>Seller: GET /s/demo-cafe/croissant
    Seller-->>Agent: 402 (amount 2.5, erc7710)
    Agent->>Agent: sign payment-specific leaf (session key)
    Agent->>Seller: Payment-Signature (leaf context)
    Seller->>Fac: /verify → simulate redeemDelegations
    Fac-->>Seller: isValid
    Seller->>Fac: /settle
    Fac->>DM: redeemDelegations (relayer pays gas)
    DM->>USDC: transfer(payTo, 2.5)
    DM-->>Fac: OK
    Fac-->>Seller: tx 0x71d71442…
    Seller-->>Agent: 200 + ticket (payer gas 0)
    end

    rect rgb(255,235,235)
    Note over Agent,DM: ② over cap — retry in the same period, cumulative 5.0 > 3.0
    Agent->>Seller: GET /s/demo-cafe/croissant (retry)
    Seller->>Fac: /verify → simulate
    Fac->>DM: simulate redeemDelegations
    DM-->>Fac: revert ERC20PeriodTransferEnforcer:transfer-amount-exceeded
    Fac-->>Seller: isValid = false
    Seller-->>Agent: 402 + offer re-issued — no settlement, funds untouched
    end

    rect rgb(255,244,229)
    Note over Agent,DM: ③ expiry — after the validity window has passed
    Fac->>DM: simulate redeemDelegations
    DM-->>Fac: revert TimestampEnforcer:expired-delegation
    Fac-->>Seller: isValid = false
    end
```

#### Settlement evidence — GIWA Sepolia (2026-07-24 ~ 2026-08-04)

Evidence levels are stated separately. **Mined** is a transaction that entered a
GIWA block and opens in the explorer; **simulated** is an `eth_call` against GIWA's
current state — the verdict is handed down by the deployed enforcer bytecode reading
the real period counter, but nothing entered a block.

| Path | Result | Evidence level | Evidence |
|---|---|---|---|
| Framework deployment | 38-unit + 2-step ownership + owner smart account | **mined** | manager `0xF2F782Fa…F40C`, owner account `0xA4e4d00E…DDF382` |
| Normal settlement (inv-001, 1 mUSDC) | success, payer gas 0 | **mined** | tx `0xe897fe55…a97d`, block 31555419 |
| Normal settlement (inv-002, 2.5 mUSDC) | success | **mined** | tx `0x71d71442…6ce4`, block 31558282 |
| **Period cap exceeded** (cumulative 5.0 > 3.0) | **refused, funds untouched** | simulated | revert `ERC20PeriodTransferEnforcer:transfer-amount-exceeded` |
| **Expiry** (validity window passed) | **refused** | simulated | revert `TimestampEnforcer:expired-delegation` |
| Sponsored onboarding — account deployment | CREATE2 deploy from the owner recovered out of a pre-deployment signature, new user gas 0 | **mined** | account `0x15286FE9…3301`, tx `0xed21ac71…9902` |
| Sponsored onboarding — mUSDC float | 3 mUSDC minted | **mined** | tx `0x9d14588b…baa0` |
| Post-hoc acceptance of a pre-deployment signature (late binding) | live `isValidSignature` = `0x1626ba7e` | simulated | account `0x15286FE9…3301` |

That the two refusals have no transaction hash is a consequence of the design. The
facilitator's `/verify` filters first with `simulate.redeemDelegations`, so no gas
is spent on a transaction destined to revert. The same 2.5 mUSDC payment settles
while balance remains in the period and is refused once the cumulative total crosses
the cap — the limit is state enforced by the deployed enforcer, not a promise made
by application code.

### Sponsored onboarding (account bootstrap)

A new user signs the root delegation against a payer smart account that **does not
exist yet**, and `apps/account-bootstrap` deploys that account with sponsor gas.
Nobody needs to hold GIWA ETH to create a delegation.

Two measurements decided the design. First, **deploying at settlement time is
impossible** — `DelegationManager` runs the signature loop before any execution, a
codeless delegator falls into the EOA branch, and `ECDSA.recover` returns the owner
rather than the account, so it ends in `InvalidEOASignature`. There is no ERC-6492
anywhere in the Framework. Second, **late binding holds** — a signature made against
a codeless account passes ERC-1271 after deployment, because `HybridDeleGator`
compares against `owner()` and the owner is baked into the CREATE2 initcode. The
`0x1626ba7e` in the table above is the value with which the live chain answered
that fact.

The request body is `{permissionContext}` and nothing else. The owner is recovered
from the signature; the account is `CREATE2(recovered owner)` and must match the
delegator the permission names. Accepting an owner or salt from the caller would let
anyone nominate an address for us to pay to deploy — in this structure, the caller
has to solve a fixed point that cannot be solved without the key. The signature is
also checked offline for canonical form (low-s, `v ∈ {27,28}`). viem accepts
signatures that OZ `ECDSA` reverts on, so without this check we would pay to deploy
accounts whose every grant reverts forever.

Per-account idempotency is identity, not a budget — keypairs are free offline, so
the real bounds on a griefing run are the faucet window (one top-up per account per
24 hours), the daily gas budget (`BOOTSTRAP_DAILY_WEI`), and the sponsor balance
kept deliberately small. The hourly per-IP cap (`BOOTSTRAP_RATE_PER_HOUR`, default
30, IPv6 counted per /64) is a speed bump on top of those: IPs are shared and keys
are free, so it cannot stop a griefer, but without any cap one machine could drain
the day's budget from one address in under an hour by sending fresh keypairs. The
faucet tops any account below 1000 tUSDC (testnet, not real money) up to that
target (`packages/delegation/src/faucet-policy.ts`). The sponsor holds no
delegation authority, so it cannot reach payer funds, caps, or settlement.
Verification is `bun run test:e2e:bootstrap` — 16 cases on a GIWA fork (kill
switch, approval mismatch, shared-relayer refusal, foreign signer, high-s,
deployment, late binding, gas accounting, faucet top-up to target, idempotency,
concurrency, faucet 24-hour window, budget exhaustion, chain-failure leak guard,
hourly per-IP cap with the header-less exemption), 16/16.

### Agent automation (MCP)

The payment loop converges on a single `payForDelegatedResource` in
`packages/delegation/src/payment-client.ts`, and the CLI agent and the MCP server
share the same implementation. Two copies of an implementation drift apart.

`apps/agent-mcp` exposes two tools.

| tool | Role |
|---|---|
| `mapae_pay_for_resource` | receive 402 → sign a leaf within the caveat → retry the request → resource |
| `mapae_status` | session key, endpoints, deployment verification state (never returns keys or the permission context) |

The procedure for registering the server in an MCP client, and the environment
variables, are in the [MCP connection guide](mcp-guide.md).

This path has run to completion on GIWA Sepolia. One MCP tool call settled a payment
with no human intervention, and in transaction
[`0x533c…9964c`](https://sepolia-explorer.giwa.io/tx/0x533c5cb2945b89c7a56abf681ef049124deb4daf141e1a52b280385cefd9964c)
(block 31634935) the payer is −1 mUSDC, the vendor +1 mUSDC, and the payer's ETH
spend is `0`. The evidence level for this path is **mined on GIWA**, not a local
fork. The same transaction is also §3's timeout case — the on-chain settlement
succeeded, and the reporting path's timeout budgets were redesigned afterwards.

**Failures are returned as reasons.** The core returns a discriminated result
instead of throwing, and points at the cause with `SELLER_OFFER_INVALID`,
`FACILITATOR_UNTRUSTED`, `MANAGER_MISMATCH`, `LIMIT_EXCEEDED`,
`PERMISSION_INACTIVE`, `SIGNING_FAILED`, `PAYMENT_REJECTED`, and the like.

**Offer selection and the receipt.** Every entry of the 402's `accepts` is walked in
the seller's order, and the first that is exact ERC-7710 on GIWA, overlaps a trusted
facilitator and does not contradict the verified DelegationManager is paid — a seller
that lists EIP-3009 first for wallets and ERC-7710 second for delegated agents is
paid as-is. When none qualifies, the reason is the first candidate's that was on the
ERC-7710 rail at all; when no candidate was, it is `SELLER_OFFER_INVALID`. The 2xx
`Payment-Response` header is read only when it is a receipt of this payment —
`success: true`, the same network, the payer the leaf was signed for — and then
`transaction` is the header's value (`""`, as the spec writes it, meaning no hash); a
missing or self-contradicting header falls back to the body's `receipt.transaction`. No
seller string from the header reaches the result. The resource is parsed only when its
content-type is JSON and returned as text otherwise, with the bearer values redacted
either way. Of the content type only the media type comes back — the parameters are
dropped, because `Content-Type` is seller text that travels as far as MCP tool output
and a bearer value parked in a parameter must not ride along.

**On-chain pre-flight.** Before signing, the agent reads the enforcer's own
accounting directly and filters out payments that cannot succeed. The chain enforces
the cap either way, so the purpose of this step is not safety but **accuracy of the
reason** — instead of going all the way to the seller and receiving a 402, it states
the cause, as in `payment of 2500000 exceeds 2000000 left in this period`. A side
effect is that no leaf is signed for a payment that cannot succeed (a leaf is a
bearer authorization).

The pre-flight verdict (`judgePreflight`) is factored out as a pure function, with
chain reads injected as callbacks. Status lookup runs `readDelegationStatus` over
**every link** of the parent permission — looking only at the root misses the
narrower cap of a re-delegated child. Two verdict rules are pinned by tests: **an
inactive reason takes precedence over the cap** (reporting a permission that cannot
spend any amount as `LIMIT_EXCEEDED` sends the operator adjusting the cap, which is
not the cause), and **the cap is the chain's minimum, not the root's value.**

**Two layers of spending limit.** An on-chain caveat is a **period** cap — it holds
several days' budget in one cell, and every individual payment inside it is legitimate.
Nothing on chain stops a single mistaken resource path from spending that whole budget in
one session. So the agent runtime lays three limits on top of it, from env
(`createAgentSpendGate`): a per-call cap `AGENT_MAX_PAYMENT_MUSDC`, a session total
`AGENT_SESSION_BUDGET_MUSDC`, and a recipient allowlist `AGENT_ALLOWED_PAY_TO`. Unset
means that limit does not exist, and the code substitutes no default of its own — leave
all three empty and the only cap is the on-chain caveat, which is the original behaviour.
The final limit is the chain either way.

Enforcement happens in exactly **one** place, immediately before the leaf is signed:
inside the gate that wraps the provider, where the verdict and the reservation sit in the
same synchronous block with no await between them — which is why concurrent calls share
one budget rather than each getting it. Split the verdict from the accounting into two
calls and that gap opens, and the session cap weakens in proportion to the number of
concurrent calls (a budget of 1.0 with five simultaneous calls signed all five: 5.0 tUSDC
measured). The gate wraps the provider so that a new call path cannot forget the
enforcement — as a separate method to call, a path that never called it would still
compile.

What the total counts is **signatures**, not charges. A signed leaf is a bearer
authorization, so the facilitator can redeem it even when the seller never delivered the
resource — counting only successful settlements would revive the budget on every failed
round trip, and a cap that grows back is not a cap. There is exactly one rollback: when
the signing itself threw. A leaf that does not exist cannot be redeemed.

A refusal has two names. The pre-flight the payment loop asks before signing (`judge`)
changes no state, and its refusal becomes the legible code `SPEND_POLICY_REFUSED`. The
reservation is not made there because pre-flight and signing are not guaranteed to be a
pair: the executor in `apps/payment-scheduler` checks its own schedule conditions inside
its provider and can refuse there, and had the pre-flight reserved, every such refusal
would strand a slice of the budget for good. So a payment that passed pre-flight and then
lost the budget to another call is caught at the signing point and reported as
`SIGNING_FAILED`, with `detail` naming which limit it was — the enforcement is not late,
the reporting is one step removed. A session is the lifetime of the runtime instance, that
is of the MCP server process; a budget that must outlive a restart is the one
`apps/payment-scheduler` keeps in its DB. The per-variable verdicts and the operational
rules are in the [MCP connection guide](mcp-guide.md) §3.1.

Two runtime behaviours:

- **Runtime loading is lazy and caches only success.** An env or network failure at
  boot returns a reason in the tool result instead of killing the process, and
  fixing the environment recovers it without a restart.
- **stdout is the JSON-RPC channel.** All logging goes to stderr.

### Studio (wallet module)

Both screens read their data directly from chain.

| Screen | Source |
|---|---|
| Delegation and limits | `ERC20PeriodTransferEnforcer.getAvailableAmount` (remaining period balance), caveat terms (cap, validity window), `DelegationManager.disabledDelegations` (revocation state) |
| Receipts | `TransferredInPeriod` events |

A settlement that consumes the cap always leaves this event, so the receipts need no
separate ledger. The remaining balance is not self-aggregated off-chain because that
would become a second truth, able to drift from the side that actually enforces.

The validity-window interpretation reflects what a 0 value means to the
`TimestampEnforcer` — the enforcer checks each half of the window only when it is
`> 0`, so a 0 in the terms means **unbounded**, not 1970.

**The receipt query window.** The query takes `fromBlock` as a required argument.
GIWA refuses `eth_getLogs` beyond 100,000 blocks, so an unbounded default would
either fail or return a truncated history as if it were complete. The default window
is 50,000 blocks, and with GIWA producing roughly 1 block per second (measured
over the 31634888→31634935 span) that is less than a day. So the screen header and
the empty-list message both show the time at which the window opens, and that time
is read from chain as the timestamp of the `fromBlock` block, not derived from an
assumed block time. If the node cannot serve that block (pruned), the message falls
back to a block-count notation and the screen stays up. When `fromBlock === 0` it is
labelled "full history". The window is fixed at 50,000 blocks; Studio does not
paginate, and the panel says so.

**The boundary of revocation.** `DeleGatorCore.disableDelegation` is
`onlyEntryPointOrSelf`, so the owner EOA cannot call it directly — it must be an
EntryPoint UserOperation. The suite exercises both branches — the *self* branch
proves the outcome via impersonation (after revocation `disabledDelegations` is
true, and the same payment is refused with `PERMISSION_INACTIVE`), and the
*EntryPoint* branch sends a UserOperation signed with the real owner key through
`handleOps`. That UserOperation's `callData` is `buildRevocationCall(...).data`
verbatim, not wrapped in `execute()` — wrapping would make it an EntryPoint →
`execute` → self call, folding back into the *self* branch already covered. Each
dependency carries a control.

| Control | What it proves | Actual result |
|---|---|---|
| `revocation-userop` | the normal path | success — `UserOperationEvent.success == true`, `disabledDelegations` true |
| `revocation-userop-unfunded` | the deposit is the real gate | `FailedOp(0,AA21 didn't pay prefund)` |
| `revocation-userop-wrong-signer` | the account verifies `owner()` | `FailedOp(0,AA24 signature error)` |
| `revocation-userop-tampered-field` | the signed `entryPoint` field is in force | `FailedOp(0,AA24 signature error)` |
| `revocation-submitter` | a JSON wire submission passes the validator and revokes | success — the validated struct matches the signed struct in all 9 fields |
| `revocation-submitter-foreign-sender` | a foreign account's revocation is refused before any chain read | `sender is not the account this submitter serves` |

**The submission endpoint (`apps/revocation-submitter`).** Anyone can call
`handleOps` and the relayer fronts the gas, so a service that forwards whatever it
is handed becomes a general-purpose UserOperation relay running on someone else's
funds. `validateRevocationSubmission` narrows it to one operation on one account — a
`sender` allowlist, the root's `delegator == sender`, `initCode` and
`paymasterAndData` forced empty, ceilings on the 4 gas fields, and **byte
equality of `callData` against a re-encode**. The last check is not a decode because
a decode passes bytes appended at the end.

The signature is deliberately not verified offline. The account is a
`HybridDeleGator` and validates through ERC-1271, so an offline `ecrecover` can
silently disagree with the account. The authority on the signature is the `AA24` the
EntryPoint returns in pre-broadcast simulation.

`judgeSubmissionReadiness` returns, as distinct reasons, the refusals that can be
judged from chain state — `prefund_short` (the payer holds ETH 0 by design, so the
deposit is the only funding source, and this is the most common state),
`fee_below_basefee` (the EntryPoint reimburses at
`min(maxFeePerGas, baseFee+priority)` while the relayer's transaction cannot be
included below `baseFee`, so sending it anyway succeeds while only the operator
loses), `base_fee_unreadable` (the base fee could not be read — a case for retry,
not re-signing, which is why its reason is kept separate from the previous one),
`relayer_unfunded`.

Success is judged by checking `UserOperationEvent.success` directly, not the receipt
status. The EntryPoint absorbs an inner call's revert into
`UserOperationRevertReason` and lets the transaction itself succeed
(`EntryPoint.sol:340-353`), so by the receipt alone a reverted `disableDelegation`
still reads as success.

**Service boot verification** (`bun run test:e2e:revoke`). Unit tests and the
negative-path suite cover the validator and the on-chain enforcement, but the boot
of the process itself — env parsing, reading the deployment artifacts, the relayer
cross-check at boot, `/health`, single-flight, simulate→broadcast — is round-tripped
by a separate e2e that actually starts the service on a GIWA fork. The suite counts
its own cases and prints `PASS — N cases (ABC…)`.

Two designs in this suite are non-obvious. First, **replay defence splits into two
cases.** The first line of defence against re-sending the same body is the deposit
gate, and in that state the nonce has never been executed. So the suite refills the
deposit to remove the gate, re-sends the identical body, and confirms that the one
remaining line of defence — the EntryPoint nonce — cuts it off with
`AA25 invalid account nonce`. Second, **the success case verifies the relayer's
balance sheet.** On GIWA the well-known Anvil development addresses carry an
EIP-7702 designator whose target is a sweeper that transfers away any incoming
balance in full. `EntryPoint._compensate` pays the beneficiary with
`call{value:…}`, so using such an address as the beneficiary empties the relayer in
a single `handleOps` (fork measurement: 1 ETH → 0.00024 ETH, transaction cost
0.00017 ETH). The suite enforces at startup that the beneficiary address has no
code.

The browser leg also checks the responses directly. The browser client (local dev
:5173) and the submitter (:8082) are different origins and the request carries
`content-type: application/json`, so the browser sends a preflight first — if the
preflight fails, the POST never goes out. The suite checks each case: that an
allowed origin's preflight gets 204, that an unknown origin gets 403, and that a
request with no `Origin` (a server-side call) works as-is.

**Studio's revoke button (`apps/web/src/dapp/RevokeButton.tsx`).** Connect the
wallet → check against `owner()` → read the nonce → build → `signTypedData` → POST
to the submission endpoint. Three design decisions: (1) **the connected wallet is
checked against the account's `owner()` before signing**
(`HybridDeleGator.sol:233`) — a signature from another wallet surfaces as `AA24` at
the EntryPoint, indistinguishable from a nonce or gas problem. (2) **The nonce is
read at click time and the operation is built in one pass** — if the value is
re-read between building and signing, the digest goes stale and the result is again
`AA24`. That is why `buildRevocationUserOperation` is a pure function. (3) The wire
body is produced by `buildRevocationSubmissionBody` from the same module the
submission endpoint uses for validation — a round-trip test pins byte-level
reproduction so the encoder and the decoder cannot diverge.

Each reason the button locks shows its own message — revocation endpoint not
configured, already revoked, wallet not connected, chain mismatch, not the owner. A
short deposit is not a lock reason — on the public path the sponsor tops up the
deposit at revoke time, and that is the reason sponsored mode exists. An owner
mismatch is reported first — the wallet is the only element the person in front of
the screen can change.

**The unverified stretch:** whether the wallet extension renders the
signature-request struct (9 fields) legibly for a human can only be confirmed with a
real wallet open. It remains the one stretch automation cannot cover.

The **funding state** of self-funded (pinned-mode) revocation — the EntryPoint
deposit, the per-revocation requirement
(`revocationPrefund(DEFAULT_REVOCATION_GAS)`), and the shortfall — is answered by
the submission endpoint's `/health`. The former D6 console displayed these values on
screen at all times (even at 0 — as long as gaslessness is the central claim, a row
that appears only when the value is not 0 is a row that cannot confirm the
invariant holds), and that principle carries over into Studio's status display.

**How the kill switch is funded.** Payments never pass through the EntryPoint — the
relayer calls `redeemDelegations` directly, so the payer's zero-ETH invariant holds
for payments. Revocation alone cannot avoid the EntryPoint, and the EntryPoint
collects gas not from the account's native balance but from the deposit
(`StakeManager.deposits`). `DeleGatorCore._payPrefund` (:559-566) absorbs a failed
transfer, so with no deposit it is the EntryPoint, not the account, that refuses
with `AA21` — not `AA23`. `EntryPoint.depositTo(address)` is `public payable` with
no access control, so the relayer can fill another account's deposit, and the
payer's native balance stays at 0 while it does. But `withdrawTo` reads
`deposits[msg.sender]`, so this is a one-way cost the relayer cannot claw back. The
procedure for completing the revocation path locally is in the
[revocation runbook](revocation-runbook.md).

**The Framework kill switch.** Where revocation severs one delegation,
`DelegationManager.pause()` stops the entire framework (`onlyOwner` — an ordinary
EOA transaction that needs no deposit). The defence is two layers: the facilitator's
`verifyFrameworkOperationalState` checks `paused` on every request and refuses
before settling, and on-chain the `whenNotPaused` on `redeemDelegations`
(`DelegationManager.sol:132`) reverts even a bypass of that gate. The suite confirms
that executing `pause()` on a fork with an impersonated owner has `/health` report
`ok=false`, `frameworkError=framework_paused` and `frameworkPaused=true`, and has
the payment turned away as not-ready rather than judged (`/verify` 503
`facilitator_not_ready`), so the agent receives `SELLER_UNAVAILABLE` — nothing
charged, retry later. `/settle` gives the same answer: when the RPC dies in the
pre-broadcast stage (simulation, gas estimate, fee query) it answers 200
`facilitator_not_ready` and writes no ledger row — nothing was judged and nothing
charged. A failure after the broadcast stays `settlement_pending`, with its hash.

### Reproduction

```bash
bun run check                      # full-stack regression, no keys or network
cd apps/delegation-lab
bun run test:negative              # caveat cases — the default target is a disposable chain
SUITE_TARGET=fork bun run test:negative   # the same cases on a GIWA fork
bun run test:e2e:mcp               # full payment run → over-cap pre-flight refusal → pause → revocation
bun run test:e2e:revoke            # actually starts the submission endpoint and round-trips it
SUITE_FORK_BLOCK=<recent block> bun run test:e2e:bootstrap   # 16 onboarding-service cases
bun run preflight:giwa             # read-only GO/NO-GO against GIWA head state
```

`test:negative`'s default target is a disposable chain. The GIWA fork target must be
run separately with `SUITE_TARGET=fork`; no single line runs both targets. All four
suites count their own cases and print the count alongside the pass verdict
(`N/N cases passed`, `PASS — N cases (ABC…)`, `GO — N개 조건 전부 충족`).

The execution requirements differ per command. `bun run check` and `test:negative`
run from a clean clone with no keys, no network, and no deployment artifacts —
`test:negative` deploys the 38-unit Framework itself onto a disposable Anvil and
tests against it. `test:e2e:mcp`, by contrast, requires a root permission artifact
signed by the owner, so it does not run from a bare clone without the wallet that
owns the deployed account. `test:e2e:bootstrap` deploys a fresh account onto a GIWA
fork and therefore reads state no cache has ever held — a recent block must be
passed as `SUITE_FORK_BLOCK` (GIWA prunes old state).

`test:e2e:mcp` refuses to start unless every child process is pinned to a loopback
RPC, and after finishing it re-reads the real GIWA relayer nonce to confirm that
nothing was broadcast.

**Fork-source credentials are never exposed in argv.** The private GIWA endpoint
carries its API key in the URL path, so the whole URL is a credential, and argv is
visible via `ps`. `anvil --fork-url` has no environment-variable alias, so
`apps/delegation-lab/fork-source-proxy.ts` holds the key in memory and hands anvil a
keyless `http://127.0.0.1:<ephemeral port>`. All four places that spawn a fork use
this path.

---

## 3. Error model

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

### The refusal words are §9's

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

### How absent state is judged

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

### Standing gates

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

### The seller's ladder — a failure that charged nobody, and one nobody confirmed

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

### Effect migration plan

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

---

## 4. Security considerations

### Facilitator trust boundary

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

### Attack vectors and countermeasures

| Vector | Countermeasure |
|---|---|
| Signature replay | EIP-3009 nonce consumption (`authorizationState`), verified by tests |
| Smart-account signatures | OZ `SignatureChecker` — supports EOA and EIP-1271 alike. Bare `ecrecover` fails silently on 4337 accounts |
| Authorization front-running | An observer can submit `transferWithAuthorization` first, but funds move only to the signed `to` — an ordering issue, not theft. Use `receiveWithAuthorization` where logic depends on the fact of receipt |
| Validity window | `validAfter`/`validBefore` enforced. The L2 sequencer's timestamp manipulation margin (seconds) is negligible against the validity window (minutes to hours) |
| Relayer authority | Amount and recipient are fixed in the signature and cannot be changed |
| Signature exposure in logs | Facilitator error logs never record the signature or the full payload — only chain, asset, amount, address, and nonce metadata |
| Facilitator attack surface | The API is exposed only on loopback/private networks; the container image is pinned by digest with read-only, cap-drop, and no-new-privileges applied |
| Redirect hijacking | Payment requests from the agent and seller refuse HTTP redirects, so the authorization in the payment header (`Payment-Signature`) never travels to another origin |
| Malicious DelegationManager | Single-manager allowlist from the GIWA deployment artifacts; canonical EntryPoint and required enforcer addresses verified |
| Permission context exposure | Excluded from Git, size-limited, never printed in logs or error detail |
| Forged payer receipts | The canonical payer is derived from the last/root delegator in the `permissionContext`; a mismatched wire claim is refused |
| verify→settle race | Re-simulation immediately before settle |
| Duplicate settle | Deduplicated by a `paymentIntentId` over the canonical payment terms and the context bytes; the broadcast tx hash is stored before the receipt |
| Gas DoS via complex delegations | Estimate first, then refuse anything above the configured gas cap |
| Unauthorized relayer | The intersection of the leaf's `RedeemerEnforcer` and the 402's `facilitatorAddresses` is enforced |
| Onboarding griefing (repeated deploy requests) | Hourly per-IP cap (a speed bump) + faucet window (one top-up per account per 24 hours) + daily gas budget + a small dedicated sponsor wallet — exhaustion stops only that day's onboarding and never touches settlement or funds |
| Settlement griefing (paying oneself repeatedly with free tUSDC) | Hourly per-IP cap + a per-payer daily gas share (`RELAYER_PAYER_DAILY_WEI`) reserved before the day's total — one payer exhausting its share leaves every other seller settling for the rest of the day. Rejected settle rows are kept in the ledger for 7 days and at most the newest 50,000 (pruned at boot and hourly), so refusals alone cannot grow the sqlite file without bound |
| Nominating the deploy target address | The request body is `{permissionContext}` only — the owner is recovered from the signature, and the account is `CREATE2(owner)`, which must match the delegator |
| Non-canonical signatures (high-s, `v ∉ {27,28}`) | Deploy only after an offline canonical-form check — viem accepts them but OZ `ECDSA` reverts, so without the check we would pay to deploy an account whose every grant reverts |
| Vulnerable dependencies | `bun audit` runs in the gate. Every finding is either fixed or accepted with a re-measurable proof attached |

### Acceptance criteria for dependency advisories

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

### The MCP server is stdio-only

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

### Logging and credentials

viem embeds the full transport URL in its error messages, and on an RPC endpoint that
carries its API key in the path, the URL itself is a credential. `redactUrls` in
`packages/shared` reduces any URL that reaches a log to `scheme://host`, and the
`check:logging` gate refuses, repository-wide, any code where a raw error reaches a
`console.*` argument. Signed payloads and permission contexts are bearer authorizations
and are never printed in logs or error detail.

---

## 5. Verified on-chain environment

| Item | Value |
|---|---|
| Network | GIWA Sepolia (`eip155:91342`) |
| RPC | `https://sepolia-rpc.giwa.io` |
| MockUSDC | `0xcfeb694719A09caeb80798e2011298F29CDa4e92` |
| EIP-712 domain | name `Mock USDC` / version `2` / decimals `6` |
| EntryPoint | canonical v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Delegation Framework v1.3 | **Deployed and verified on GIWA** — DelegationManager `0xF2F782Fa…F40C` (active, owner=admin, unpaused), 38-unit exact composition |
| Owner smart account (payer) | `0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382` (HybridDeleGator, owner EOA `0x011234B8…B901`) |
| ERC20PeriodTransferEnforcer | `0x700330288f6f094780121ea54cd2eDEfe45b3625` |
| First sponsored onboarding account | `0x15286FE9A48d52504607bEaaa021B29194353301` (a pre-deployment signature returned `0x1626ba7e` from live ERC-1271, mUSDC balance 3.0) |

This table holds only entries verified by reading them directly, address in
hand. Dojang appears in the roadmap, but this repository has never verified its
addresses, so it is not included here — what is verified and what is planned do
not share a table.

---

## 6. Verification status and roadmap

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
  spend is `0`. The service itself is verified by 16 cases on a GIWA fork
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
  (detailed evidence in [Deployed contracts](deployed-contracts.md))
- **Numeric discipline on the public web** — the figures the public web
  (`apps/web`) displays are restricted to three sources: direct chain reads,
  mined hashes, and revert reasons checked by the negative-path suite

The settlement ledger, the daily gas budget and transaction-hash recovery for the same
payment are implemented in SQLite. Hashes are stored before sending, a restart looks up the
original receipt, and a success is counted once. This is locally regression-tested code,
separate from evidence of a production rollout. One facilitator process per signer is
required, for that signer's nonce and budget handling.

Settlement automation's triggers, scheduler, execution history and retry policy are
implemented in `apps/payment-scheduler` (§1): interval slots and `nextAt`, the
`payment_runs` history with its `runs` query, `maxAttempts`/`retryDelayMs`, and the two
failures that are retried automatically. Their reasons differ: `TRANSPORT_ERROR` is a
connection that died before the payment header left the process, while `SELLER_UNAVAILABLE`
is the seller answering 503 — the header did go out, and the answer says nothing was charged.
What makes the second safe to retry after the header is on the wire is that its ground is the
seller's answer rather than the transport. A slot whose outcome is unresolved keeps its
reservation, stops, and is never resumed automatically.

To be built:

- **Task-level compound delegation** — binding one task made of several sellers and
  resources into a single delegation. Today every payment signs a fresh leaf out of the
  root period delegation, so the task's boundary is written in the schedule row rather
  than in the delegation
- **KYC and attestation verification path** — Dojang KYC gate + EAS
  contract/receipt schemas + resolvers
- **Fulfillment verification** — an optimistic structure (default pass,
  challenge window, bond). Designed on the premise that it is not trustless,
  because the final adjudicator is arbitration rather than re-execution
