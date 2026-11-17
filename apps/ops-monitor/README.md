# ops-monitor

The Cloudflare Worker that watches Mapae from outside the Mac mini and talks to the
operator over Telegram. It is the only holder of the bot token.

| Entry | What it does |
|---|---|
| cron `*/5 * * * *` | Runs the public probes (`src/probes.ts`, shared with `scripts/ops/check.ts`) and checks collector heartbeats, then alerts on state transitions |
| `POST /ingest` | Bearer `INGEST_TOKEN`. The metrics collector's hourly invariants and daily snapshot. A daily one also sends the reports below |
| `POST /telegram` | Bot webhook. `/status`, `/report`, `/help` from `TELEGRAM_CHAT_ID` only |

## Reports

All reports come from `src/report.ts` and are sent as Telegram HTML. Every value in them
is escaped. Each message has a fixed set of rows and shows at most five failure reasons,
so it stays under 4096 characters without being cut.

- **Daily**, on every daily ingest, including a re-run of the same day. It shows the eight
  headline figures for that KST day in three columns (`int`/`coh`/`org`), each with a
  delta against the previous day's snapshot: root settlements, broadcast success
  (settled/(settled+error)), external payees, payee top-1 share, paying wallets, repeat
  paying wallets, payments not relayed by Mapae (target 0; defined in
  `apps/metrics-collector/README.md`), and limit rejections. Limit rejections are the
  attempts the facilitator journalled as refused by the delegation's own limits (period
  cap, amount allowance, expiry, revocation; `LIMIT_REJECTIONS` in
  `packages/shared/src/ops-ingest.ts`), at `/verify` or `/settle`. It is a count of
  attempts, so a retried request counts again. If no snapshot exists for the previous day, the report
  says so and shows no deltas.
- **Weekly**, for the latest Monday-to-Sunday week whose Sunday snapshot is stored. It
  normally goes out with the Monday 00:30 run that closes Sunday. It is built from the
  stored Sunday snapshot and compared with the snapshot from seven days earlier. Shares
  and retention are shown as numerator/denominator. W1/W4 retention is retained/eligible
  per column. The week is stored in `weekly_reports`, keyed by its Sunday, only after
  Telegram accepts the message. A failed or late send goes out with the next daily
  ingest, and a re-run never sends it twice.
- **`/report`** sends the daily report for the latest stored snapshot.

## Alerting rules

- Each check has a row in `alert_state`. ok→fail sends at once, a check that stays failing
  is reminded at most hourly, fail→ok sends once. All transitions from one run go out as
  one message.
- If Telegram does not accept a message, the transition is not stored, so the next run
  sends it again.
- Collector heartbeats: `collector-heartbeat-hourly` fails after 2 h without an hourly
  ingest, `collector-heartbeat-daily` after 26 h. A kind that has never sent anything
  does not alert. The first ingest turns the check on.
- Hourly items are stored as `hourly:<name>`. An item that was failing and then stops
  arriving is resolved as "no longer reported", so it does not send reminders forever.

## `/ingest` contract

The type and parser are `packages/shared/src/ops-ingest.ts`, imported by both this Worker
and `apps/metrics-collector`, which validates every payload with the same parser before
sending. The daily snapshot's shape is `DailySnapshot` in that module.

```jsonc
// hourly — the collector decides pass/fail; the Worker decides when to notify
{"kind": "hourly", "items": [{"name": "pending-intents", "ok": false, "detail": "2 older than 5m"}]}
// daily — one snapshot per day; sending the same day again replaces it
{"kind": "daily", "day": "2026-10-12", "snapshot": { /* a full DailySnapshot for that day */ }}
```

`parseDailySnapshot` checks the whole daily snapshot at ingest. It refuses unknown keys,
negative or fractional counts, and a share whose part exceeds its whole. A snapshot the
reports could not read is rejected right away, rather than surfacing later as a broken
report.

Item names match `^[a-z0-9][a-z0-9-]{0,47}$`. There are at most 64 items. `detail` is
optional, one line, up to 200 characters. It is sent to Telegram as written, so it must
never contain a secret, a URL, or a raw error. Unknown keys are rejected, and the body
can be at most 256 KiB. Times come from the Worker's clock, not from the sender.

## Tests

```bash
cd apps/ops-monitor && bun test     # also part of the root `bun run test:ts`
```

Telegram, the probe targets and D1 are all faked. `src/snapshot-fixture.ts` builds a valid snapshot. D1 runs as `schema.sql` on `bun:sqlite`.

## Deploy runbook

These steps need the operator's approval. Nothing below runs automatically. Every
command runs from `apps/ops-monitor`. The steps keep each secret out of shell arguments
(argv is visible in `ps`). Secrets are read from chmod-600 files or a hidden prompt.

1. **Create the bot.** In Telegram, open @BotFather, send `/newbot`, and copy the token.
   Then load it into this shell without echoing it:

   ```bash
   read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN
   ```

2. **Find the chat id.** Send any message to the new bot, then:

   ```bash
   printf 'url = "https://api.telegram.org/bot%s/getUpdates"\n' "$TELEGRAM_BOT_TOKEN" \
     | curl -s --config - | jq '.result[].message.chat.id'
   ```

   `printf` is a shell builtin, so the token goes to curl on stdin and never appears in
   a process list.

3. **Generate the two Worker-only secrets** (no trailing newline, because Telegram
   compares the webhook secret byte for byte):

   ```bash
   mkdir -p ~/.mapae && chmod 700 ~/.mapae
   (umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.mapae/ops-ingest-token)
   (umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.mapae/ops-telegram-webhook-secret)
   ```

   The metrics collector on the Mac mini needs the same ingest token. Copy that file
   there with `chmod 600`. Do not paste it into a chat.

4. **Create D1 and apply the schema.**

   ```bash
   bunx wrangler d1 create mapae-ops
   # set the printed database_id in wrangler.jsonc, and decline wrangler's offer to add a binding
   bunx wrangler d1 execute mapae-ops --remote --file schema.sql
   ```

5. **Register the secrets.** `secret put` prompts for each value, or reads it from stdin:

   ```bash
   printf %s "$TELEGRAM_BOT_TOKEN" | bunx wrangler secret put TELEGRAM_BOT_TOKEN
   bunx wrangler secret put TELEGRAM_CHAT_ID            # the id from step 2
   bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET < ~/.mapae/ops-telegram-webhook-secret
   bunx wrangler secret put INGEST_TOKEN < ~/.mapae/ops-ingest-token
   bunx wrangler secret put SELLER_METRICS_TOKEN        # the seller's METRICS_TOKEN
   bunx wrangler secret put FACILITATOR_METRICS_TOKEN   # the facilitator's METRICS_TOKEN
   ```

6. **Deploy.**

   ```bash
   bun run deploy
   ```

   It prints the `https://mapae-ops-monitor.<account>.workers.dev` URL.

7. **Register the webhook.** Telegram calls this URL, and every call carries the secret
   header:

   ```bash
   printf 'url = "https://api.telegram.org/bot%s/setWebhook"\n' "$TELEGRAM_BOT_TOKEN" \
     | curl -s --config - \
       --data-urlencode "url=https://mapae-ops-monitor.<account>.workers.dev/telegram" \
       --data-urlencode "secret_token@$HOME/.mapae/ops-telegram-webhook-secret" \
       --data-urlencode 'allowed_updates=["message"]' \
       --data 'drop_pending_updates=true'
   ```

8. **Verify.** Send `/help` and `/status` to the bot. `bunx wrangler tail` shows the cron
   runs. A failing probe shows up within five minutes.

To run it locally, copy `.dev.vars.example` to `.dev.vars`, then use `bun run dev` and
`curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`. With real values in
`.dev.vars`, that local run sends real Telegram messages.

If the Worker later moves to `ops.mapae.io`, keep the `global_fetch_strictly_public`
compatibility flag. Without it, a fetch to a Worker on the same zone is routed internally,
so the probes would no longer see what a visitor sees.
