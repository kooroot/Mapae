import {expect, test} from "bun:test";
import {ARCADE_PAY_TO, ARCADE_SELLER} from "@mapae/arcade/tickets";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC} from "@mapae/shared";
import {arcadePolicy, checkGiwaCatalogue} from "./giwa-client";

    test("owner permission has a lifetime budget, fixed payee, token and expiry", async () => {
        const p = arcadePolicy(36);
        expect(p.periodAmount).toBe(36_000_000n); expect(p.lifetimeTotalAmount).toBe(36_000_000n);
        expect(p.recipient).toBe(ARCADE_PAY_TO); expect(p.expiresAfterSeconds).toBe(7200);
        for (const count of [0, -1, 37, 0.5, NaN]) expect(() => arcadePolicy(count)).toThrow();
        const catalogue = {slug: "mapae-arcade", network: GIWA_SEPOLIA_CAIP2, payTo: ARCADE_PAY_TO, asset: MOCK_USDC.address,
            items: ["race", "shop", "stamp"].map(key => ({key, price: "1.00", url: `${ARCADE_SELLER}/${key}`}))};
        const fetcher = (price: string) => Object.assign(async () => Response.json({...catalogue,
            items: catalogue.items.map(item => ({...item, price}))}), {preconnect: fetch.preconnect});
        await checkGiwaCatalogue(fetcher("1.00"));
        await expect(checkGiwaCatalogue(fetcher("0.01"))).rejects.toThrow("tickets are not available");
        await expect(checkGiwaCatalogue(fetcher("2.00"))).rejects.toThrow("tickets are not available");
    });
