Mapae single-host operations tools

All commands run from the repository root using the lockfile-pinned dependencies.
Do not run a second funded facilitator instance to test these tools.

READ-ONLY INVENTORY (run on the actual serving Mac)
  python3 scripts/ops/inventory.py
Lists launchd labels, selected paths, listeners and local disk space. It never
prints EnvironmentVariables or process arguments. A missing service is not a
reason to kill the listener. Resolve its actual system/gui domain first.

PUBLIC CHECK (may run on another existing computer, independently of the server)
  bun scripts/ops/check.ts
Exit 1 means an unhealthy/missing dependency, incorrect token quote, exposed
profile, or local disk below 10%/5 GiB. Local disk means the machine executing
this command. It does not infer the remote server's disk space.
Optional operator metrics:
  bun scripts/ops/check.ts --metrics-key-file /private/path/metrics.json
The chmod-600 JSON file contains existing seller and facilitator metrics tokens:
  {"seller":"...", "facilitator":"..."}
It checks remaining gas budget above 10% and <20% failed attempts (at least 20
attempts). Rejected requests count as failed; this is an incident signal, not
payment conversion. No notification is sent by this command. An independent
monitor must alert on nonzero exit / missing scheduled heartbeat; a dead Mac
cannot report its own death. Test actual notification delivery separately.

ENCRYPTED SQLITE SNAPSHOT
Create a private 32-byte hex key file with openssl rand -hex 32 redirected into a
new chmod-600 file. Keep a second copy of that key OFF the serving Mac, separate
from backup files. Never paste it into an issue, chat, log or shell argument.
  bun scripts/ops/backup.ts backup /absolute/service.sqlite /backup/new.enc /private/key
  bun scripts/ops/backup.ts drill /backup/new.enc /private/key
VACUUM INTO takes a consistent committed snapshot including WAL. Encryption is
AES-256-GCM with fresh nonces; wrong keys/tampering fail authentication. Output
must not already exist. The drill decrypts into a temporary private directory,
checks SQLite integrity/foreign keys, and removes the temporary plaintext.
The current encryption step buffers the snapshot in memory: do one service at
a time, with free RAM and disk greater than three times that database's size.
Backups on the same disk are NOT disaster recovery. Copy encrypted files to an
existing independent disk/off-device destination and test the copied file.
Do not automatically prune the last verified off-device copy.

RESTORE TO A NEW FILE (does not change the running service)
  bun scripts/ops/backup.ts restore /backup/new.enc /recovery/new.sqlite /private/key
Refuses to overwrite any destination. Stop affected service(s) before replacing
active files manually; keep originals INCLUDING WAL/SHM as evidence. Before a
financial service resumes, reconcile chain receipts, signer nonce and budget
reservations since the snapshot. Old budgets/nonce journals must never simply
be started as if no newer transactions happened. No tool here sends a transaction.

READ-ONLY FINANCIAL RECONCILIATION
  bun scripts/ops/reconcile.ts /absolute/seller.sqlite /absolute/facilitator.sqlite
  bun scripts/ops/reconcile.ts /absolute/seller.sqlite /absolute/facilitator.sqlite --chain
Optional --profiles /recovery/d1-export.sqlite joins durable cloud admissions.
The cloud file is an isolated SQLite database loaded from a D1 export, never a
Worker's live storage directory. It contains private profile data; chmod 600.
--chain reads the public GIWA RPC for anomalous rows only. It never replays,
refunds, reassigns nonces, clears pending rows, or fabricates a missing ticket.
A successful journal row without a seller order and a pending row older than
five minutes require operator investigation. A facilitator may serve external
shops: missing local orders for those shops are not automatically incidents.
Compare payee/resource provenance before taking any repair action.
A 404, timeout, or empty mempool is NOT proof that a payment failed.

PROFILE RESTORE / ROLLOUT
Before reopening traffic after any D1 restore, rotate PROFILE_GENERATION in
apps/web/src/arcade/profile/model.ts and deploy BOTH web Workers while writes
remain closed. Clear restored session/challenge tables so an earlier logout is
not undone by the database rewind. Old open tabs keep their drafts; choosing the
server copy preserves the old draft separately without merging it into restored
data. Never use a recovered snapshot's smaller revision as a new starting point
while old-generation Workers still accept writes. Restore-generation rotation
is a runbook step, not an automatic consequence of Cloudflare Time Travel.

This release adds arcade_checkouts to apps/web/schema/arcade.sql. Rollout order:
1. Back up mini databases and export/bookmark D1; keep the previous source SHA.
2. Configure the same new 32+ character ARCADE_RECEIPT_TOKEN on the mini seller
   and as a secret on BOTH web Workers: wrangler secret put ARCADE_RECEIPT_TOKEN
   --env landing, then --env app. Enter through the prompt, never a VITE_* variable,
   command argument, public file or log. Keep it distinct from metrics tokens.
   Anonymous receipt lookup returns 401; missing configuration blocks checkout.
3. Install/restart updated mini seller + facilitator using discovered labels,
   with the new seller secret loaded. Confirm /health reports arcadeRecovery:true.
4. Apply the additive D1 schema. Do not drop existing profile/auth tables.
5. Deploy BOTH web Workers, then test an authenticated ticket recovery.
New checkout code refuses fresh payments if the seller's health lacks the new
arcadeRecovery capability. Old unsigned POST proxy paths are removed.
Already open pages from the old release must refresh; no compatibility payment
path is retained. Old pre-release payments without a cloud checkout still need
seller/chain support reconciliation. No production action is performed by reading
this file or running the inventory/check/drill commands.
