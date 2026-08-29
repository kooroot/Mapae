# @mapae/seller

Hono middleware that puts any route behind an [x402](https://x402.org) paywall settled in
**tUSDC on GIWA Sepolia** — a testnet asset, not money — through Mapae's public facilitator.
The buyer is an agent holding an ERC-7710 delegation; it pays without a signature prompt
per call, inside a period limit its owner signed once.

```bash
bun add @mapae/seller     # or: npm i @mapae/seller
```

Peer dependencies: `hono >= 4.13`, `viem >= 2.55`. Runs on Node 20+ and Bun; no Bun-only
API is used.

## Usage

```ts
import {Hono} from "hono";
import {MAPAE_MANIFEST_PATH, mapaeManifest, mapaePaywall} from "@mapae/seller";

const app = new Hono();

app.get(
    "/api/report",
    mapaePaywall({payTo: process.env.PAY_TO!, price: "0.01", description: "Daily report"}),
    (c) => c.json({report: "…"}),
);

app.get(
    MAPAE_MANIFEST_PATH, // "/.well-known/mapae.json"
    mapaeManifest({
        name: "My report API",
        payTo: process.env.PAY_TO!,
        endpoints: [{path: "/api/report", price: "0.01", description: "Daily report"}],
    }),
);

export default {fetch: app.fetch, port: 3000, idleTimeout: 45}; // Bun — see "Timeouts"
```

### `mapaePaywall(options)`

| option | |
|---|---|
| `payTo` | Your receiving address. Settlements go there directly; Mapae never holds funds. |
| `price` | tUSDC as a decimal string, positive, up to 6 fractional digits — `"0.01"`. |
| `description` | One line the buyer's agent reads in the 402 offer. |
| `facilitator` | Defaults to `https://facilitator.mapae.io`. HTTPS unless loopback. |
| `onSettled` | `(receipt) => void \| Promise<void>`, called once per settled payment, **before** your handler. Write your ledger here. A throw is logged; the buyer is still served. |
| `fetch` | Injected transport, for tests. |

Without a payment header the request gets a **402** carrying the x402 v2 offer in the
`Payment-Required` header and the JSON body. With one, the middleware asks the facilitator
to `/verify` and then `/settle`, and only a confirmed settlement lets your handler run
(settle-before-serve). The receipt rides in `Payment-Response`, and your handler can read
it with `c.get("mapaeReceipt")`:

```ts
interface SettlementReceipt {
    intent: Hex;       // idempotency key of this exact payment (the facilitator's replay key)
    payer: Address;    // root delegator that paid
    amount: string;    // "0.01"
    asset: Address;    // tUSDC
    payTo: Address;
    network: "eip155:91342";
    transaction?: Hex; // GIWA tx hash
}
```

| status | meaning |
|---|---|
| `402` | no payment header — normal for humans and `curl` |
| `503 facilitator_unavailable` | `/supported` or `/verify` unreachable; nothing charged, retry later |
| `400 malformed_payment` | header is not a usable ERC-7710 payment |
| `403 delegation_rejected` | facilitator refused the delegation (expired, over limit, over the 10.00 cap, offer mismatch) |
| `504 settlement_unknown` | broadcast but no receipt seen — the buyer **may** have been charged; do not re-sign blindly |
| `422 settlement_failed` | transfer did not happen; nothing charged |
| `404` | the paywall is the last matched route — it never prices a route nothing serves |

Two routes at the same price share one offer (the offer carries no path), so a header
bought for one opens the other. Use distinct prices, or check `receipt.intent` against
your ledger.

### `mapaeManifest(options)`

Serves `{version: 1, name, chain: "eip155:91342", asset, payTo, facilitator, endpoints}`
at `GET /.well-known/mapae.json`. Every value is validated at construction, so a bad
price or address stops the process at boot rather than a buyer at runtime.

## The facilitator

`https://facilitator.mapae.io` is public and needs no registration or key. It simulates
(`/verify`), redeems the delegation and broadcasts the tUSDC transfer (`/settle`), and pays
the gas. Per-settlement cap: 10.00 tUSDC. The middleware reads its signer addresses and
DelegationManager from `GET /supported` and copies them into every offer, so your server
needs no deployment files.

## Timeouts

`/verify` gets 15 s and `/settle` 35 s. Whatever serves the app needs an idle timeout
above that; Bun's default is 10 s, which would hang up on your own settlement — hence
`idleTimeout: 45` above. On Node, `@hono/node-server`'s defaults are fine.

## Testnet only

Incoming balances are GIWA Sepolia tUSDC. They cannot be converted, and nothing here is
a payment in the legal sense. The Korean 10-minute guide is
[docs/seller-guide.md](https://github.com/kooroot/Mapae/blob/main/docs/seller-guide.md)
(published at <https://docs.mapae.io/operations/seller-guide>).

## Building inside the monorepo

`exports["."]` maps `types` to `dist/index.d.ts` and `import` to `dist/index.js`, both
build outputs, while the `bun` condition points at `src/index.ts` so Bun runs the source
directly. The root `typecheck` therefore starts with `build:seller` — a clean clone needs
no manual step before `bun run check`. The build is `tsc --emitDeclarationOnly` for the
types plus `bun build` with `hono` and `viem` external, so the workspace-private
`@mapae/shared` and `@mapae/delegation` code the middleware uses is bundled in and neither
appears in the published tarball's imports.

If the `@mapae` npm organisation is not available at publish time, this package ships
unscoped as `mapae-seller` with the same API.

MIT
