import {expect, test} from "bun:test";
import {openStore} from "@mapae/store";
import {seedArcade} from "./seed-arcade";
import {ARCADE_PAY_TO} from "@mapae/arcade/tickets";

test("arcade catalogue is idempotent and pins testnet admission prices and payee", () => {
    const store = openStore(":memory:");
    try {
        seedArcade(store, 1000); seedArcade(store, 2000);
        expect(store.sellers.get("mapae-arcade")?.payTo).toBe(ARCADE_PAY_TO);
        const items = store.items.listBySeller("mapae-arcade");
        expect(items.map(i => i.key).sort()).toEqual(["race", "shop", "stamp"]);
        expect(items.every(i => i.priceBase === 1_000_000n && i.createdAt === 1000)).toBe(true);
    } finally {store.close();}
});
