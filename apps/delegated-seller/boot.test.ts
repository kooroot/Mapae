import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PAYMENT_SIGNATURE_HEADER} from "@mapae/shared";
import {TRIAL_NOTICE, type ShopManifest, type TicketResponse, type VerifiedTicket} from "./app.js";
import {
    FACILITATOR_ROUTES,
    LEAF_A,
    LEAF_B,
    LEAF_C,
    PAY_TO,
    paymentHeader,
    type FacilitatorPath,
} from "./test-support.js";

/**
 * The shop as the operator runs it: `bun run seed` into a store file, `index.ts` booted
 * from env in its own process, a facilitator that is a real listener. What `app.test.ts`
 * cannot see from inside the process — the env parsing, the seed command, the file on
 * disk that a reconciliation script would open, the server's own body limit — is what
 * this suite is for.
 */

const ONE = 1_000_000n;
const METRICS_TOKEN = "boot-metrics-token-sixteen";
const AMERICANO = "/s/demo-cafe/americano";
const LOGO = "/s/demo-studio/logo";

const dir = mkdtempSync(join(tmpdir(), "mapae-shop-boot-"));
const storePath = join(dir, "seller.sqlite");

const childEnv = (overrides: Record<string, string>) => ({
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...overrides,
});

/** The operator's command, exactly: the seed script in the app's own directory. */
function seed(): number {
    const run = Bun.spawnSync([process.execPath, "run", "seed.ts"], {
        cwd: import.meta.dir,
        env: childEnv({STORE_PATH: storePath, SEED_PAY_TO: PAY_TO}),
        stdout: "ignore",
        stderr: "pipe",
    });
    if (run.exitCode !== 0) console.error(new TextDecoder().decode(run.stderr));
    return run.exitCode;
}

/** A second, read-only connection to the file the booted shop is writing. */
function readRows<T>(sql: string): T[] {
    const db = new Database(storePath, {readonly: true});
    try {
        return db.query<T, []>(sql).all();
    } finally {
        db.close();
    }
}

/**
 * Boot `index.ts` under `env` and expect it to refuse: what it printed before exiting.
 * A shop that boots instead is killed, and the empty string it yields fails the test.
 * A refusal takes 60 ms here; the wait is bounded well under bun's 5 s per-test limit,
 * which used to fire first and leave the booted child listening on its port.
 */
async function bootRefusal(env: Record<string, string>): Promise<string> {
    const child = Bun.spawn([process.execPath, "run", "index.ts"], {
        cwd: import.meta.dir,
        env: childEnv({STORE_PATH: storePath, ...env}),
        stdout: "ignore",
        stderr: "pipe",
    });
    try {
        const exited = await Promise.race([child.exited, Bun.sleep(3_000).then(() => "still running")]);
        if (exited === "still running") return "";
        expect(exited).not.toBe(0);
        return await new Response(child.stderr).text();
    } finally {
        child.kill();
    }
}

let facilitator: ReturnType<typeof Bun.serve> | undefined;
let seller: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
let baseUrl = "";
let facilitatorUrl = "";

beforeAll(async () => {
    // Mounted under a path: `createMapae` admits `FACILITATOR_URL=…/hop`, and the shop
    // must advertise that hop as given rather than refuse it as not being an origin.
    facilitator = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) =>
            FACILITATOR_ROUTES[new URL(request.url).pathname.replace(/^\/hop/, "") as FacilitatorPath]?.() ??
            new Response("", {status: 404}),
    });
    facilitatorUrl = `http://127.0.0.1:${facilitator.port}/hop`;
    expect(seed()).toBe(0);

    // A port nothing holds right now; the shop cannot take 0 because its base URL —
    // the manifest's item links — is derived from the port it is told.
    const probe = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("")});
    const port = probe.port;
    probe.stop(true);
    baseUrl = `http://127.0.0.1:${port}`;

    seller = Bun.spawn([process.execPath, "run", "index.ts"], {
        cwd: import.meta.dir,
        env: childEnv({
            HOST: "127.0.0.1",
            PORT: String(port),
            FACILITATOR_URL: facilitatorUrl,
            STORE_PATH: storePath,
            METRICS_TOKEN,
        }),
        stdout: "ignore",
        stderr: "pipe",
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${baseUrl}/health`, {signal: AbortSignal.timeout(1_000)})).ok) return;
        } catch {
            /* not listening yet */
        }
        await Bun.sleep(200);
    }
    seller.kill();
    throw new Error(`the shop did not boot: ${await new Response(seller.stderr).text()}`);
});

afterAll(() => {
    seller?.kill();
    facilitator?.stop(true);
    rmSync(dir, {recursive: true, force: true});
});

async function pay(path: string, leaf: `0x${string}`): Promise<TicketResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
        headers: {[PAYMENT_SIGNATURE_HEADER]: paymentHeader(ONE, leaf)},
    });
    expect(response.status).toBe(200);
    return (await response.json()) as TicketResponse;
}

describe("the booted shop", () => {
    test("seeding again changes no row in the file", () => {
        const before = readRows<{id: number; created_at: number}>("SELECT id, created_at FROM items ORDER BY id");
        expect(before).toHaveLength(3);
        expect(seed()).toBe(0);
        expect(readRows("SELECT id, created_at FROM items ORDER BY id")).toEqual(before);
    });

    test("serves the seeded shops from the file, advertising the facilitator it was given", async () => {
        const manifest = (await (await fetch(`${baseUrl}/s/demo-cafe`)).json()) as ShopManifest;
        expect(manifest.slug).toBe("demo-cafe");
        expect(manifest.payTo).toBe(PAY_TO);
        // Loopback shop, loopback facilitator: PUBLIC_FACILITATOR_URL unset defaults to
        // the hop itself as `createMapae` normalised it, path included.
        expect(manifest.facilitator).toBe(facilitatorUrl);
        expect(((await (await fetch(`${baseUrl}/health`)).json()) as {facilitator: string}).facilitator).toBe(facilitatorUrl);
        expect(manifest.items.map((item) => [item.key, item.price, item.url])).toEqual([
            ["americano", "1.00", `${baseUrl}${AMERICANO}`],
            ["croissant", "2.50", `${baseUrl}/s/demo-cafe/croissant`],
        ]);
        const page = await (await fetch(`${baseUrl}/s/demo-studio`, {headers: {accept: "text/html"}})).text();
        expect(page).toContain(TRIAL_NOTICE);
        expect(page).toContain("로고 시안");
    });

    test("three settlements are three rows in the file; a replayed header is the original ticket", async () => {
        expect((await fetch(`${baseUrl}${AMERICANO}`)).status).toBe(402);

        const first = await pay(AMERICANO, LEAF_A);
        const second = await pay(AMERICANO, LEAF_B);
        // The studio's logo costs what the americano does and pays the same address, so
        // only the leaf tells the two intents apart.
        const third = await pay(LOGO, LEAF_C);
        const codes = [first, second, third].map((t) => t.ticket.code);
        expect(new Set(codes).size).toBe(3);
        expect(third.ticket.shop.slug).toBe("demo-studio");
        expect(new Set([first, second, third].map((t) => t.receipt.intent)).size).toBe(3);

        // The americano's header presented for the logo: same intent, so the first
        // ticket again — the logo is never delivered for a payment made for coffee.
        const replay = await pay(LOGO, LEAF_A);
        expect(replay.ticket).toEqual(first.ticket);

        const rows = readRows<{seller_slug: string; item_key: string; payment_intent_id: string; ticket: string}>(
            "SELECT seller_slug, item_key, payment_intent_id, ticket FROM orders ORDER BY id",
        );
        expect(rows.map((row) => `${row.seller_slug}/${row.item_key}`)).toEqual([
            "demo-cafe/americano",
            "demo-cafe/americano",
            "demo-studio/logo",
        ]);
        expect(rows.map((row) => row.payment_intent_id)).toEqual(
            [first, second, third].map((t) => t.receipt.intent),
        );
        expect(rows.map((row) => row.ticket)).toEqual(codes);

        // The code the buyer holds is what the counter checks, at the shop that issued it.
        const shown = await fetch(`${baseUrl}/s/demo-studio/tickets/${third.ticket.code}`);
        expect(shown.status).toBe(200);
        expect((await shown.json()) as VerifiedTicket).toMatchObject({
            code: third.ticket.code,
            item: {key: "logo"},
            status: "paid",
        });
        expect((await fetch(`${baseUrl}/s/demo-cafe/tickets/${third.ticket.code}`)).status).toBe(404);
    });

    test("/metrics counts the file's orders, behind the token", async () => {
        expect((await fetch(`${baseUrl}/metrics`)).status).toBe(401);
        const response = await fetch(`${baseUrl}/metrics`, {headers: {authorization: `Bearer ${METRICS_TOKEN}`}});
        expect(response.status).toBe(200);
        const body = (await response.json()) as {orders: {allTime: unknown}};
        expect(body.orders.allTime).toEqual({total: 3, bySeller: {"demo-cafe": 2, "demo-studio": 1}});
    });

    test("a body past 16 KiB is refused by the server, before any route sees it", async () => {
        const small = await fetch(`${baseUrl}/health`, {method: "POST", body: "x".repeat(1_024)});
        expect(small.status).toBe(404);
        const large = await fetch(`${baseUrl}/health`, {method: "POST", body: "x".repeat(16_385)});
        expect(large.status).toBe(413);
    });
});

describe("boot refuses to point buyers at their own machine", () => {
    const publicShop = {HOST: "127.0.0.1", PORT: "3001", BASE_URL: "https://shop.example"};

    test("a public BASE_URL with the default loopback facilitator", async () => {
        expect(await bootRefusal(publicShop)).toContain("PUBLIC_FACILITATOR_URL must be set when BASE_URL is not loopback");
    });

    test("a public BASE_URL with an explicit loopback PUBLIC_FACILITATOR_URL", async () => {
        expect(await bootRefusal({...publicShop, PUBLIC_FACILITATOR_URL: "http://localhost:8081"})).toContain(
            "PUBLIC_FACILITATOR_URL must not be loopback when BASE_URL is not loopback",
        );
    });

    test("a FACILITATOR_URL the seller refuses is refused under the seller's rule, by name", async () => {
        // The shop's reader used to run ahead of `createMapae` and judge FACILITATOR_URL
        // by the stricter origin rule, under a variable the operator never set.
        const refusal = await bootRefusal({FACILITATOR_URL: "http://127.0.0.1:8081/hop?x=1"});
        expect(refusal).toContain("facilitator must be a base URL without query or fragment");
        expect(refusal).not.toContain("PUBLIC_FACILITATOR_URL");
    });

    test("a PUBLIC_FACILITATOR_URL that is not a bare HTTPS origin", async () => {
        expect(await bootRefusal({...publicShop, PUBLIC_FACILITATOR_URL: "https://facilitator.example/v1"})).toContain(
            "PUBLIC_FACILITATOR_URL must be an origin",
        );
        expect(await bootRefusal({...publicShop, PUBLIC_FACILITATOR_URL: "http://facilitator.example"})).toContain(
            "PUBLIC_FACILITATOR_URL must use HTTPS unless it is loopback",
        );
    });
});
