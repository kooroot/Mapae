# ENG-8 — `mapae_pay_for_resource` result confirms itself

The pay tool's result now says, on its own, whether the payment settled and where to look.

## What changed

- `apps/agent-mcp/server.ts`
  - Success: adds `settlement` (`"confirmed"` iff `transaction` is a 32-byte hex hash, else `"unconfirmed"`), `explorerUrl` (`explorerTxUrl(transaction)`, only with a hash) and `next` (one line: open the explorer link, or the Studio receipt screen at `/app` when there is no hash). `resourceUrl`, `amount`, `payTo`, `transaction`, `contentType`, `resource` are unchanged.
  - Failure `SETTLEMENT_UNKNOWN`: adds `retry: false`, `next` (do not pay again before checking the hash or balance) and `explorerUrl` when the seller named a hash.
  - Failure `LIMIT_EXCEEDED`, `SELLER_UNAVAILABLE`: add `retry: true`. Every other code keeps `{ok, code, status, detail}`.
  - Tool description gains: "A SETTLEMENT_UNKNOWN result must not be retried until the transaction hash or the balance has been checked — the payer may already be charged."
- `packages/delegation/src/payment-client.ts`: the failure result gains an optional `transaction` (only on `SETTLEMENT_UNKNOWN`, only the hash `readSellerRefusal` matched against `^0x[0-9a-fA-F]{64}$`). One assertion added to `payment-client.test.ts`.
- `apps/agent-mcp/pay-result.test.ts` (new, 6 tests): drives the real server in-process over `InMemoryTransport` with a scripted seller on a stubbed `fetch` (no network).
- `docs/mcp-guide.md` §1 row updated; §6 unchanged. README / README.ko test-count digits 2009 → 2015, MCP 18 → 24.

## Example results

Success (seller sent a receipt hash):

```json
{
  "ok": true,
  "resourceUrl": "http://127.0.0.1:3001/s/demo-cafe/americano",
  "amount": "1.0 mUSDC",
  "payTo": "0x2000000000000000000000000000000000000001",
  "transaction": "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
  "contentType": "application/json",
  "resource": {"ticket": "ok"},
  "settlement": "confirmed",
  "explorerUrl": "https://sepolia-explorer.giwa.io/tx/0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
  "next": "Paid. Open explorerUrl to see the settled transaction."
}
```

`SETTLEMENT_UNKNOWN` (seller answered 504 with `settlement_pending` and a hash):

```json
{
  "ok": false,
  "code": "SETTLEMENT_UNKNOWN",
  "status": 504,
  "detail": "seller reported settlement_pending (504) — the payer may already be charged — transaction 0xcdcd…cdcd",
  "retry": false,
  "explorerUrl": "https://sepolia-explorer.giwa.io/tx/0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
  "next": "Do not pay again yet: check this transaction hash on the explorer (or the mUSDC balance) first — the payment may already be charged."
}
```

(`detail` abbreviated here; the tool returns the full hash.)

## How tested

- `bun test packages/delegation/src/payment-client.test.ts` — 74 pass
- `bun test apps/agent-mcp` — 24 pass (6 new in `pay-result.test.ts`; each case also asserts the raw result text contains neither the fixture private key nor the permission context)
- `bun run check:counts` (arcade assets installed as ci.yml does), `bun run check:mcp-stdio`, `bun run typecheck && bun run check:docs`

## Rollback

`git revert` the merge commit. Nothing is deployed by this change; the `mapae.mcpb` archive the Operator serves only picks it up at the next `bun run build:mcpb`, so until then reverting is code-only.

## Assumptions

- `retry: true` is set for every `LIMIT_EXCEEDED`, including the `lifetime total` variant the guide says will not reopen by waiting. The done criteria ask for it unconditionally; a retry there is harmless (the preflight refuses again before anything is signed), but the agent should still read `detail`.
- "Confirmed" means the seller named a well-formed hash in its receipt (or body). The server does not query the chain to check that the transaction was mined; `next` sends the user to the explorer for that.
- `next` strings are English, matching the rest of the tool output; the Studio screen is referred to as "the Studio receipt screen at /app".
- On `SETTLEMENT_UNKNOWN` without a hash, `next` names the mUSDC balance and the Studio receipt screen as the places to check.
- The new MCP test stubs the global `fetch` (the server does not take a `fetchImpl`) rather than reusing the delegation package's private helpers; the fixtures mirror `payment-client.test.ts`.
