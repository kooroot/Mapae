import {Hono} from "hono";
import {MAPAE_MANIFEST_PATH, mapaeManifest, mapaePaywall, type MapaeEnv} from "@mapae/seller";
import {GIWA_SEPOLIA_CAIP2, toTokenAmount} from "@mapae/shared";
import {getAddress, isAddress, zeroAddress, type Address} from "viem";

/**
 * Timeout budgets, and why this one is set explicitly.
 *
 * Four timeouts stack on one payment, and they have to grow outward:
 *
 *   facilitator receipt wait  <  paywall's settle call  <  this server's idle
 *   timeout  <  the agent's own request timeout
 *
 * They were inverted. `Bun.serve`'s **default `idleTimeout` is 10 s**, which made the
 * outermost hop the shortest, while the facilitator waits up to 60 s for a receipt. On
 * GIWA that produced the worst available outcome: the transfer was mined
 * (`0x533c5cb2…9964c`, block 31634935, payer −1.00 mUSDC) and the agent was told the
 * payment had failed. An inverted budget does not lose a payment — it loses the *answer*
 * about a payment, which is harder to recover from.
 *
 * `@mapae/seller` gives `/settle` 35 s. This must exceed that, or this server hangs up
 * on its own settlement. `idleTimeout` is in seconds and capped at 255 by Bun.
 */
const IDLE_TIMEOUT_SECONDS = 45;

function readPayTo(): Address {
    const value = process.env.PAY_TO?.trim() ?? "";
    if (!isAddress(value)) {
        throw new Error("PAY_TO must be the public vendor address, never a private key");
    }
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error("PAY_TO must not be zero");
    return address;
}

function readPort(): number {
    const value = Number(process.env.PORT ?? 3001);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error("PORT must be between 1 and 65535");
    }
    return value;
}

const PAY_TO = readPayTo();
// Validated by the paywall at construction: HTTP(S), no credentials, HTTPS unless loopback.
const FACILITATOR_URL = process.env.FACILITATOR_URL?.trim() || "http://127.0.0.1:8081";
const HOST = process.env.HOST?.trim() || "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    throw new Error("HOST must be loopback");
}
const PORT = readPort();

const DELIVERABLES: Record<
    string,
    {price: string; description: string; body: Record<string, unknown>}
> = {
    "inv-001": {
        price: "1.00",
        description: "Delegated design deliverable — invoice inv-001",
        body: {invoice: "inv-001", deliverable: "logo-final.svg"},
    },
    "inv-002": {
        price: "2.50",
        description: "Delegated translation deliverable — invoice inv-002",
        body: {invoice: "inv-002", deliverable: "spec-ko.md"},
    },
};

/**
 * No two deliverables may cost the same, and that is a security condition rather than a
 * catalogue preference.
 *
 * A payment is bound to its offer by the facilitator's `sameRequirement`, which compares
 * network, asset, amount, payTo and maxTimeoutSeconds. None of those is the resource:
 * x402 v2 keeps `resource` at the top level of the 402 body, so it never reaches the
 * validator, and `paymentIntentId` does not hash it either. Two entries at one price
 * therefore produce byte-identical requirements, and a header bought for one satisfies
 * the offer for the other. Nothing downstream catches it — this seller holds no record
 * of which intent it has already served, so it would ship both.
 *
 * The catalogue is safe today because 1.00 and 2.50 happen to differ. That is a
 * coincidence, not a mechanism, and the failure it prevents would arrive silently with
 * whoever adds a third item. Refusing to start converts it into something that cannot be
 * reintroduced without being noticed. Keyed on the encoded token amount rather than the
 * decimal string, because "1.0" and "1.00" are different strings and the same offer.
 */
const priceOwners = new Map<string, string>();
for (const [id, item] of Object.entries(DELIVERABLES)) {
    const amount = toTokenAmount(item.price).toString();
    const owner = priceOwners.get(amount);
    if (owner !== undefined) {
        throw new Error(
            `DELIVERABLES ${owner} and ${id} both cost ${item.price}; payment requirements ` +
                "carry no resource identity, so one payment would buy both",
        );
    }
    priceOwners.set(amount, id);
}

const app = new Hono<MapaeEnv>();
app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
});

app.get("/health", (c) =>
    c.json({
        ok: true,
        network: GIWA_SEPOLIA_CAIP2,
        paymentMethod: "erc7710",
        payTo: PAY_TO,
        facilitator: FACILITATOR_URL,
    }),
);

// One paywall per deliverable: a paywall is one price, and the 402 offer, the ladder
// and the receipt all come from the package. What is left here is the catalogue.
for (const [id, item] of Object.entries(DELIVERABLES)) {
    app.get(
        `/delegated/deliverable/${id}`,
        mapaePaywall({
            payTo: PAY_TO,
            price: item.price,
            description: item.description,
            facilitator: FACILITATOR_URL,
            onSettled: (receipt) => {
                console.log(
                    `[settled] ${id} intent=${receipt.intent} payer=${receipt.payer} ` +
                        `tx=${receipt.transaction ?? "unconfirmed"}`,
                );
            },
        }),
        (c) => c.json({...item.body, receipt: {method: "erc7710", ...c.get("mapaeReceipt")}}),
    );
}
app.get("/delegated/deliverable/:id", (c) => c.json({error: "unknown deliverable"}, 404));

app.get(
    MAPAE_MANIFEST_PATH,
    mapaeManifest({
        name: "Mapae reference seller",
        payTo: PAY_TO,
        facilitator: FACILITATOR_URL,
        endpoints: Object.entries(DELIVERABLES).map(([id, item]) => ({
            path: `/delegated/deliverable/${id}`,
            price: item.price,
            description: item.description,
        })),
    }),
);

console.log(`delegated seller listening on ${HOST}:${PORT}`);
console.log(`  payTo       ${PAY_TO}`);
console.log(`  facilitator ${FACILITATOR_URL}`);
export default {
    hostname: HOST,
    port: PORT,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch: app.fetch,
};
