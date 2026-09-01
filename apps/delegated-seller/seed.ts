import {toTokenAmount} from "@mapae/shared";
import {openStore, type MapaeStore} from "@mapae/store";
import {getAddress, isAddress, zeroAddress, type Address} from "viem";
import {readStorePath} from "./env.js";

/**
 * The operator's two demo shops. `internal`, so a public seller list can hide them.
 *
 * The studio's logo costs exactly what the cafe's americano does, on purpose: same
 * payTo, same amount, so a payment header for one derives the same intent as for the
 * other. That is the case the orders table exists for, and the e2e pays it.
 */
export const DEMO_SHOPS = [
    {
        slug: "demo-cafe",
        name: "데모 카페",
        items: [
            {key: "americano", name: "아메리카노", description: "따뜻한 아메리카노 한 잔", price: "1.00"},
            {key: "croissant", name: "크루아상", description: "버터 크루아상 한 개", price: "2.50"},
        ],
    },
    {
        slug: "demo-studio",
        name: "데모 스튜디오",
        items: [{key: "logo", name: "로고 시안", description: "로고 시안 한 장 (PNG)", price: "1.00"}],
    },
] as const;

/**
 * Upsert the demo shops. Idempotent: the store keeps `created_at` and item ids on
 * conflict and rewrites only the columns given here, so a second run with the same
 * `payTo` changes no row.
 */
export function seedShops(store: MapaeStore, payTo: Address, now = Date.now()): void {
    for (const shop of DEMO_SHOPS) {
        store.sellers.upsert({
            slug: shop.slug,
            kind: "hosted",
            name: shop.name,
            payTo,
            internal: true,
            createdAt: now,
        });
        for (const item of shop.items) {
            store.items.upsert({
                sellerSlug: shop.slug,
                key: item.key,
                name: item.name,
                description: item.description,
                priceBase: toTokenAmount(item.price),
                createdAt: now,
            });
        }
    }
}

/** `SEED_PAY_TO`, or the server's `PAY_TO` — a public receiving address, never a key. */
function readSeedPayTo(): Address {
    const value = process.env.SEED_PAY_TO?.trim() || process.env.PAY_TO?.trim() || "";
    if (!isAddress(value)) {
        throw new Error("SEED_PAY_TO (or PAY_TO) must be the public receiving address, never a private key");
    }
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error("SEED_PAY_TO must not be the zero address");
    return address;
}

if (import.meta.main) {
    const payTo = readSeedPayTo();
    const store = openStore(readStorePath());
    try {
        seedShops(store, payTo);
        for (const shop of DEMO_SHOPS) {
            const items = store.items.listBySeller(shop.slug);
            console.log(`[seed] ${shop.slug} (${shop.name}) → ${payTo}: ${items.map((item) => item.key).join(", ")}`);
        }
        console.log(`[seed] store ${store.path}`);
    } finally {
        store.close();
    }
}
