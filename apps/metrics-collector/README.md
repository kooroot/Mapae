# metrics-collector

Runs on the Mac mini under launchd. It reads the facilitator and seller stores
read-only, indexes three Framework events from GIWA, and sends the results to the
`apps/ops-monitor` Worker at `POST /ingest`. It knows nothing about Telegram. The Worker
is the only sender.

| Mode | Schedule | Sends |
|---|---|---|
| `hourly` | every hour | `{kind: "hourly", items}`: named pass/fail invariants |
| `daily` | 00:30 KST | `{kind: "daily", day, snapshot}`: the day that just closed in Korea |

The payload type, its parser and the token rule live in `packages/shared/src/ops-ingest.ts`,
and both this app and the Worker import them. Before every POST, the collector runs the
payload through the Worker's own parser, so a payload the Worker would refuse fails on
this machine first.

## Hourly items

| Item | Fails when |
|---|---|
| `pending-intents` | a settlement intent has had no terminal event for over 5 minutes |
| `settled-without-order` | a settled intent has no seller order |
| `order-settlement-mismatch` | an order disagrees with the journal |
| `settlement-errors-24h` | any broadcast ended in `error` in the last 24 h |
| `relayer-budget` | 10% or less of today's (UTC) relayer gas budget is left |
| `ledger-readable` | either store cannot be opened. The five items above are then still sent, as failures marked `not measured`, so the Worker never reads their absence as a recovery |
| `wallet-<role>` | a funded wallet is below `WALLET_MIN_WEI`, or its balance cannot be read |

The first three come from `scripts/ops/reconcile.ts` itself, so the collector reuses that
logic instead of keeping a copy. A facilitator can serve external shops, so read
`settled-without-order` the way `scripts/ops/README.txt` says to.

## Daily snapshot

The indexer starts at the block of the Framework's first deployment transaction
(`deployments/giwa-sepolia.framework-chain-journal.json`) and reads up to the `finalized`
head. It reads at most `METRICS_LOG_SPAN` blocks per `eth_getLogs` call. The default is
10,000, the public endpoint's limit, and a provider endpoint may allow fewer. The first
run covers every block since that deployment, about 1,000 calls per event at the default
span, plus a receipt and a block for every event found, and takes well over an hour on
the public endpoint. An interrupted first run resumes at its cursor. Its cursor and decoded events
are stored in `METRICS_DB_PATH`, keyed by `(txHash, logIndex)`. A repeated or interrupted
run never counts an event twice. The file carries a schema version. A file at any other
version is dropped and indexed again from the start block, because every row in it comes
from the chain.

If the finalized head has not reached the end of the measured KST day, the run fails
instead of sending a short snapshot. No daily heartbeat arrives, and the Worker reports
that. Re-running `bun run index.ts daily` later the same morning overwrites the day.

- **Settlement**: a `RedeemedDelegation` with `authority == ROOT_AUTHORITY` and
  `redeemer ==` the settlement signer. Each payment emits its root link next to its leaf,
  so the collector indexes roots only. It indexes every root, whoever redeemed it, and
  stores the redeemer. Only the signer's count as settlements. The payee is the recipient
  of the token `Transfer` out of the payer in the same receipt.
- **Payment not relayed by Mapae** (`payerGasViolations`, target 0): a root redemption
  whose payer is a Mapae payer and whose transaction the settlement signer did not send.
  A Mapae payer is an account with at least one settlement by the end of the window, or
  one deployed by `BOOTSTRAP_ADDRESS`. The signer pays a payment's gas only by sending
  its transaction, so any other sender means the gas came from the payer's side (the
  owner, the agent key, or the account's EntryPoint deposit) or from a facilitator Mapae
  does not run. The chain does not say which, so the figure is an upper bound on "the
  payer paid gas". Revocations are not counted. They go through the EntryPoint and are
  charged to the account's deposit, which the revocation sponsor fills, so a
  `UserOperationEvent` cannot show whose money paid.
- **Revocation**: `DisabledDelegation`. **Onboarding**: `SimpleFactory.Deployed` in a
  transaction sent by `BOOTSTRAP_ADDRESS`.
- **Columns**: an address is `internal` if the deployment artifacts, the D3 session
  addresses, the arcade's payee and redeemer, the configured wallets,
  `METRICS_INTERNAL_ADDRESSES`, or a seller shop marked `internal` name it. It is `cohort`
  if `METRICS_COHORT_FILE` lists it. Otherwise it is `organic`. If an address is in both
  lists, internal wins. Each figure goes in its payer's column.
- **Days** are KST calendar days. A repeat payer is a payer whose settlements fall on two
  or more distinct KST days.
- **Self-payments** (payer == payTo) are counted only as `selfPayments`.
- `chain.toBlock` and `chain.blockHash` record exactly which chain state the figures
  describe. Token amounts are left out on purpose: MockUSDC can be minted freely.

- **Retention** (`retention.w1`, `retention.w4`) counts from the KST day of a payer's
  first settlement. A payer is retained in week N if it settled on any day in
  [first+7N, first+7N+7). The denominator includes only payers whose week N had fully
  ended by the end of the measured day, so a new payer is never counted as churned.
- **Payee concentration** (`payeeTop1`) is reported as a part and a whole, not as a
  ratio, so 0/0 can be told apart from 0%.

`ledger` holds the facilitator journal's figures for the same KST day, and `week_ledger`
holds the figures for the seven days ending on that day. The success rate is
settled / (settled + error). Rejected requests are listed but never used as a denominator.

## Run

```bash
cp .env.example .env && chmod 600 .env    # fill in; see the comments there
bun run index.ts hourly
bun run index.ts daily
bun test                                  # also part of the root `bun run test:ts`
```

## launchd (operator approval required)

`launchd/` holds the two agents. Like the other plists on the mini, they are handwritten
with short lines and no DOCTYPE, because long pasted lines corrupted every generated
version. Replace `USER` and the checkout path, then check each file with `plutil -lint`
before you load it. If you skip that check and a placeholder is left in, `launchctl`
reports only `Load failed: 5`.
`StartCalendarInterval` uses the Mac's local time zone, so 00:30 means KST only if the
mini is set to Seoul.

```bash
cp launchd/io.mapae.metrics-*.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/io.mapae.metrics-*.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.mapae.metrics-hourly.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.mapae.metrics-daily.plist
```

The plists hold no secrets. Bun reads `.env` from `WorkingDirectory`.
