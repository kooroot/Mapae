/**
 * Test-only `node --import`, loaded after `../fixtures/fake-chain-preload.mjs`: answers
 * every request to the manifest's own SELLER_URL origin with one ERC-7710 402 offer of
 * FAKE_SELLER_AMOUNT base units, in-process, so no listener is opened and the manifest's
 * SELLER_URL stays as shipped. A signed retry (Payment-Signature present) is answered 500
 * and counted in FAKE_SELLER_LOG, so a test can prove the spend gate refused before signing.
 */
import {appendFileSync} from "node:fs";

const origin = new URL(process.env.SELLER_URL).origin;
const amount = process.env.FAKE_SELLER_AMOUNT;
const log = process.env.FAKE_SELLER_LOG;
const inner = globalThis.fetch;

globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) return inner(input, init);
    const signed = request.headers.has("payment-signature");
    if (log) appendFileSync(log, `${JSON.stringify({url: request.url, signed})}\n`);
    if (signed) return new Response("unexpected signed retry", {status: 500});
    return Response.json(
        {
            x402Version: 2,
            accepts: [
                {
                    scheme: "exact",
                    network: "eip155:91342",
                    asset: "0xcfeb694719A09caeb80798e2011298F29CDa4e92",
                    amount,
                    payTo: "0x4000000000000000000000000000000000000004",
                    maxTimeoutSeconds: 60,
                    extra: {
                        assetTransferMethod: "erc7710",
                        facilitatorAddresses: [process.env.FAKE_FACILITATOR_SIGNER],
                    },
                },
            ],
        },
        {status: 402},
    );
};
