# @mapae/seller

Hono middleware that puts any route behind an [x402](https://x402.org) paywall settled in
**tUSDC on GIWA Sepolia** — a testnet asset, not money — through Mapae's public facilitator.
The buyer is an agent holding an ERC-7710 delegation; it pays without a signature prompt
per call, inside a period limit its owner signed once.

```bash
npm i @mapae/seller hono viem     # or: bun add @mapae/seller hono viem
```

Peer dependencies: `hono >= 4.13`, `viem >= 2.55`. Runs on Node ≥ 18 and Bun — no Bun-only
API is used, and the Node path is verified against the packed tarball by `bun run smoke:node`
(see "Building inside the monorepo").

## One route

```ts
import {Hono} from "hono";
import {MAPAE_MANIFEST_PATH, mapaeManifest, mapaePaywall} from "@mapae/seller";

const app = new Hono();

app.get(
    "/api/report",
    mapaePaywall({payTo: process.env.PAY_TO!, price: "0.01", description: "Daily report"}),
    (c) => c.json({report: "…"}),
);

// "/.well-known/mapae.json" — derived from the paywalls mounted on `app`; nothing to list by hand.
app.get(MAPAE_MANIFEST_PATH, mapaeManifest({name: "My report API", app}));

export default {fetch: app.fetch, port: 3000, idleTimeout: 45}; // Bun — see "Timeouts"
```

## Several routes — `createMapae(options)`

One facilitator client — one `/supported` cache, one set of timeouts — shared by every
paywall of a server, and a manifest bound to the same facilitator:

```ts
import {Hono} from "hono";
import {MAPAE_MANIFEST_PATH, createMapae} from "@mapae/seller";

const mapae = createMapae({baseUrl: process.env.BASE_URL}); // e.g. https://shop.example
const app = new Hono();

app.get("/reports/daily", mapae.paywall({payTo: PAY_TO, price: "0.01", description: "Daily report"}), daily);
app.get("/reports/:id", mapae.paywall({payTo: PAY_TO, price: "1.00", description: "One report"}), one);
app.get(MAPAE_MANIFEST_PATH, mapae.manifest({name: "My report API", app}));
```

| option | |
|---|---|
| `facilitator` | Defaults to `https://facilitator.mapae.io`. HTTPS unless loopback. |
| `baseUrl` | The origin buyers reach you at — `https://shop.example`, with no path, query or trailing slash. When set, a 402's `resource.url` is `baseUrl + path` instead of the URL the request arrived on, so a server behind a tunnel or a reverse proxy advertises its public address rather than `http://127.0.0.1:3000/…`. |
| `fetch` | Injected transport, for tests. |

`mapaePaywall(options)` is `createMapae(options).paywall(options)` — it takes these three
options as well, and makes a client of its own each time.

### `mapae.paywall(options)`

| option | |
|---|---|
| `payTo` | Your receiving address. Settlements go there directly; Mapae never holds funds. |
| `price` | tUSDC as a decimal string, positive, up to 6 fractional digits — `"0.01"`. |
| `description` | One line the buyer's agent reads in the 402 offer and in the manifest. |
| `onSettled` | `(receipt) => void \| Promise<void>`, called once per settled payment, **before** your handler. Write your ledger here. A throw is logged; the buyer is still served. |
| `extensions` | `Record<string, unknown>` placed in the 402 body's `extensions` slot — and in the `Payment-Required` header, which encodes the same document. Absent, the slot is absent. It travels in a header on every unpaid request: keep it small. |

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

Two routes at the same price and `payTo` share one offer (the offer carries no path), so a
header bought for one opens the other. Use distinct prices, or check `receipt.intent` against
your ledger.

### `mapae.manifest({name, app})` · `mapaeManifest({name, app, facilitator?})`

Serves, at `GET /.well-known/mapae.json`:

```json
{"version": 1, "name": "My report API", "chain": "eip155:91342",
 "asset": "0xcfeb694719A09caeb80798e2011298F29CDa4e92",
 "facilitator": "https://facilitator.mapae.io",
 "endpoints": [
   {"method": "GET", "path": "/reports/:id", "price": "1.00", "description": "One report", "payTo": "0x…"},
   {"method": "GET", "path": "/reports/daily", "price": "0.01", "description": "Daily report", "payTo": "0x…"}
 ]}
```

`endpoints` is read off `app.routes`: every paywall this package made, wherever it is
mounted — directly, under `app.basePath()`, inside a sub-app joined with `app.route()`, or
with `app.use("/api/*", …)` (listed as method `ALL` on that pattern) — each with its own
`payTo`. A route that is not paywalled is not listed, and a paywall cannot be left out.
Sorted by path, then method. The app is read on the first request to the manifest, after
every route has been mounted in whichever order you wrote them, and the result is kept:
Hono refuses a new route once the first request has been matched, so what that request saw
is what the server has. Prices, addresses and descriptions are validated when the paywall
is made, so a bad one stops the process at boot rather than a buyer at runtime.

## The facilitator

`https://facilitator.mapae.io` is public and needs no registration or key. It simulates
(`/verify`), redeems the delegation and broadcasts the tUSDC transfer (`/settle`), and pays
the gas. Per-settlement cap: 10.00 tUSDC. The middleware reads its signer addresses and
DelegationManager from `GET /supported` and copies them into every offer, so your server
needs no deployment files. The answer is cached for five minutes; if a re-fetch fails, the
last answer keeps serving and `503` is only returned while nothing has ever been learned.

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
build outputs and the only code the tarball contains (`files` is `dist` and this README).
The root `typecheck` therefore starts with `build:seller` — a clean clone needs no manual
step before `bun run check`. The build is `tsc --emitDeclarationOnly` for the types plus
`bun build` with `hono` and `viem` external, so the workspace-private `@mapae/shared` and
`@mapae/delegation` code the middleware uses is bundled in and neither appears in the
published tarball's imports.

`bun run smoke:node` (needs the npm registry) builds, runs `npm pack`, installs the tarball
with `hono` and `viem` into a temp project outside the repository and, under `node`, asserts
the 402 offer (ERC-7710 kind, `resource.url` from `baseUrl`) and the manifest derived from
two paywalls with two receiving addresses. It prints the Node version it ran under.

If the `@mapae` npm organisation is not available at publish time, this package ships
unscoped as `mapae-seller` with the same API.

MIT
