import {describe, expect, test} from "bun:test";
import {createConfig, http} from "wagmi";
import {mock} from "wagmi/connectors";
import {BaseError, custom, type Hex} from "viem";
import {giwaSepolia} from "@mapae/shared";
import {buildRootDelegationTypedData} from "@mapae/delegation/signing";
import {GiwaWalletError, giwaWalletError, requestGiwaSignature} from "./giwa-wallet";

const owner = "0x0000000000000000000000000000000000000011";
const signature: Hex = `0x${"11".repeat(65)}`;
const typedData = buildRootDelegationTypedData("0x0000000000000000000000000000000000000033", {
    delegator: owner, delegate: "0x0000000000000000000000000000000000000022",
    authority: `0x${"ff".repeat(32)}`, caveats: [], salt: "0x00", signature: "0x",
});

function wallet() {
    const config = createConfig({chains: [giwaSepolia], connectors: [mock({accounts: [owner]})],
        transports: {[giwaSepolia.id]: http()}, storage: null, ssr: true});
    const connector = config.connectors[0]!;
    connector.getAccounts = async () => [owner];
    connector.getChainId = async () => giwaSepolia.id;
    const requests: {method: string; params?: unknown}[] = [];
    connector.getProvider = async () => custom({request: async (request: {method: string; params?: unknown}) => {
        requests.push(request);
        return signature;
    }})({chain: giwaSepolia, retryCount: 0});
    return {config, connector, requests};
}

describe("GIWA wallet signing boundary", () => {
    test("uses the chosen wallet and only GIWA typed-data signing, without a transaction", async () => {
        const {config, connector, requests} = wallet();
        let shown = false;
        expect(await requestGiwaSignature({config, connector, owner, typedData,
            signal: AbortSignal.timeout(1000), onRequest: () => {shown = true;}})).toBe(signature);
        expect(shown).toBe(true);
        expect(requests.map(r => r.method)).toEqual(["eth_signTypedData_v4"]);
        const params = requests[0]!.params as [string, string];
        expect(params[0]).toBe(owner);
        expect(JSON.parse(params[1]).domain.chainId).toBe(91342);
        expect(JSON.parse(params[1]).primaryType).toBe("Delegation");
    });

    test("an Ethereum wallet is refused despite cached GIWA state, before any signing request", async () => {
        const {config, connector, requests} = wallet();
        connector.getChainId = async () => 1;
        expect(config.state.chainId).toBe(91342);
        await expect(requestGiwaSignature({config, connector, owner, typedData,
            signal: AbortSignal.timeout(1000), onRequest: () => {throw Error("Must not show signing");}})).rejects.toMatchObject({name: "ConnectorChainMismatchError"});
        expect(requests).toEqual([]);
    });

    test("a different owner is refused before any signing request", async () => {
        const {config, connector, requests} = wallet();
        connector.getAccounts = async () => ["0x0000000000000000000000000000000000000044"];
        await expect(requestGiwaSignature({config, connector, owner, typedData,
            signal: AbortSignal.timeout(1000), onRequest: () => {throw Error("Must not show signing");}})).rejects.toMatchObject({name: "ConnectorAccountNotFoundError"});
        expect(requests).toEqual([]);
    });

    test("a signature that arrives after timeout cannot resume downstream deployment", async () => {
        const {config, connector} = wallet();
        const pending = Promise.withResolvers<Hex>();
        const started = Promise.withResolvers<void>();
        connector.getProvider = async () => custom({request: async () => {started.resolve(); return pending.promise;}})({chain: giwaSepolia, retryCount: 0});
        const stop = new AbortController();
        let deployments = 0;
        const outcome = requestGiwaSignature({config, connector, owner, typedData, signal: stop.signal, onRequest: () => {}})
            .then(() => {deployments++;}).catch(e => e);
        await started.promise;
        stop.abort();
        expect(await outcome).toBeInstanceOf(GiwaWalletError);
        pending.resolve(signature);
        await Bun.sleep(1);
        expect(deployments).toBe(0);
    });

    test("an already stopped request never reaches the wallet", async () => {
        const {config, connector, requests} = wallet();
        await expect(requestGiwaSignature({config, connector, owner, typedData,
            signal: AbortSignal.abort(), onRequest: () => {throw Error("Must not show signing");}})).rejects.toMatchObject({code: "timeout"});
        expect(requests).toEqual([]);
    });

    test("wallet errors are classified without exposing provider payloads", () => {
        const cause = Object.assign(new Error("signed-request-must-stay-private"), {code: -32002});
        const error = giwaWalletError(new BaseError("provider failure", {cause}));
        expect(error?.code).toBe("pending");
        expect(error?.message).not.toContain(cause.message);
        expect(giwaWalletError({code: 4001})?.code).toBe("rejected");
        expect(giwaWalletError(new Error("unknown provider data"))).toBe(null);
    });
});
