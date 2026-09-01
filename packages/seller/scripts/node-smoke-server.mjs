// Runs under node, copied by node-smoke.mjs into a temp project where `@mapae/seller` is
// the packed tarball and hono/viem come from the registry. No test runner: plain
// assertions, one line each, non-zero exit on the first count of failures.
import {createServer} from "node:http";
import {Hono} from "hono";
import {MAPAE_MANIFEST_PATH, createMapae} from "@mapae/seller";

const FACILITATOR_SIGNER = "0x3000000000000000000000000000000000000001";
const DELEGATION_MANAGER = "0x4000000000000000000000000000000000000001";
const CAFE = "0x2000000000000000000000000000000000000001";
const STUDIO = "0x2000000000000000000000000000000000000002";
const BASE_URL = "https://shop.example";

/** What a facilitator's GET /supported advertises for GIWA Sepolia ERC-7710. */
const SUPPORTED = {
    kinds: [
        {
            x402Version: 2,
            scheme: "exact",
            network: "eip155:91342",
            extra: {
                assetTransferMethod: "erc7710",
                facilitatorAddresses: [FACILITATOR_SIGNER],
                delegationManager: DELEGATION_MANAGER,
            },
        },
    ],
};

const stub = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/supported") {
        response.writeHead(200, {"content-type": "application/json"});
        response.end(JSON.stringify(SUPPORTED));
        return;
    }
    response.writeHead(404);
    response.end();
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const facilitator = `http://127.0.0.1:${stub.address().port}`;

let failures = 0;
function check(ok, message) {
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
    if (!ok) failures += 1;
}

try {
    const mapae = createMapae({facilitator, baseUrl: BASE_URL});
    const app = new Hono();
    app.get(
        "/s/demo-cafe/americano",
        mapae.paywall({payTo: CAFE, price: "1.00", description: "Americano"}),
        (c) => c.json({ticket: 1}),
    );
    app.get(
        "/s/demo-studio/logo",
        mapae.paywall({payTo: STUDIO, price: "2.50", description: "Logo draft"}),
        (c) => c.json({ticket: 2}),
    );
    app.get(MAPAE_MANIFEST_PATH, mapae.manifest({name: "node smoke", app}));

    const unpaid = await app.request("http://127.0.0.1:3000/s/demo-cafe/americano?table=4");
    check(unpaid.status === 402, `unpaid request answers 402 (got ${unpaid.status})`);
    const offer = await unpaid.json();
    const accepted = offer.accepts?.[0];
    check(accepted?.extra?.assetTransferMethod === "erc7710", "the offer is the ERC-7710 kind");
    check(accepted?.payTo === CAFE, `the offer pays the cafe (${accepted?.payTo})`);
    check(
        offer.resource?.url === `${BASE_URL}/s/demo-cafe/americano`,
        `resource.url honours baseUrl (${offer.resource?.url})`,
    );
    check(typeof unpaid.headers.get("Payment-Required") === "string", "Payment-Required header is set");

    const manifest = await app.request(`http://127.0.0.1:3000${MAPAE_MANIFEST_PATH}`);
    check(manifest.status === 200, `manifest answers 200 (got ${manifest.status})`);
    const document = await manifest.json();
    check(
        document.version === 1 && document.chain === "eip155:91342" && document.facilitator === facilitator,
        "manifest names version 1, GIWA Sepolia and the facilitator",
    );
    const endpoints = (document.endpoints ?? []).map((e) => [e.method, e.path, e.price, e.payTo]);
    const expected = [
        ["GET", "/s/demo-cafe/americano", "1.00", CAFE],
        ["GET", "/s/demo-studio/logo", "2.50", STUDIO],
    ];
    check(
        JSON.stringify(endpoints) === JSON.stringify(expected),
        `manifest lists both paywalls with their own payTo (${JSON.stringify(endpoints)})`,
    );
} finally {
    stub.close();
}

console.log(`node ${process.version} — ${failures === 0 ? "every assertion held" : `${failures} assertion(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
