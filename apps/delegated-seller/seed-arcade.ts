import {ARCADE_PAY_TO, ARCADE_TICKETS, ARCADE_TICKET_PRICE} from "@mapae/arcade/tickets";
import {MOCK_USDC, toTokenAmount} from "@mapae/shared";
import {openStore, type MapaeStore} from "@mapae/store";
import {readStorePath} from "./env.js";

/** Registration only: the existing seller reads its catalogue on every request. */
export function seedArcade(store: MapaeStore, now = Date.now()): void {
    store.sellers.upsert({slug: "mapae-arcade", kind: "hosted", name: "Mapae Arcade",
        payTo: ARCADE_PAY_TO, internal: false, createdAt: now});
    for (const [key, item] of Object.entries(ARCADE_TICKETS)) {
        store.items.upsert({sellerSlug: "mapae-arcade", key, ...item,
            priceBase: toTokenAmount(ARCADE_TICKET_PRICE), createdAt: now});
    }
}

if (import.meta.main) {
    const store = openStore(readStorePath());
    try {
        seedArcade(store);
        console.log(`Registered 3 Mapae Arcade tickets, ${ARCADE_TICKET_PRICE} ${MOCK_USDC.symbol} each. No chain transaction.`);
    } finally {store.close();}
}
