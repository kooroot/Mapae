import {describe, expect, test} from "bun:test";
import {createSiweMessage} from "viem/siwe";
import {getAddress, keccak256, parseEther, parseTransaction, recoverTransactionAddress, stringToHex, toHex, verifyMessage, type Address, type Hex, type TransactionSerialized} from "viem";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {giwaSepolia} from "@mapae/shared";
import {
    ENTRY_POINT_V07, FRAMEWORK_COMPOSITION_ID, buildD3Policies, buildRootDelegationTypedData, buildSponsoredBootstrapApproval,
    ownerPayerAccount, preparePeriodDelegation, validateAccountBootstrap, withDelegationSignature,
} from "@mapae/delegation";
import {BROWSER_KEY_STORAGE_KEY, browserKey, createBrowserKeyProvider, exportBrowserKey, type BrowserKeyConfirm, type BrowserKeyRequest, type KeyStore} from "./browser-key-connector";

const address = (suffix: number): Address => getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
/** Shaped like packages/delegation/src/account-bootstrap.test.ts:54-67. */
const environment: SmartAccountsEnvironment = {
    DelegationManager: address(0x11),
    EntryPoint: ENTRY_POINT_V07,
    SimpleFactory: address(0x22),
    implementations: {HybridDeleGatorImpl: address(0x33)},
    caveatEnforcers: {
        ValueLteEnforcer: address(0x41), ERC20PeriodTransferEnforcer: address(0x42), ERC20TransferAmountEnforcer: address(0x43),
        AllowedCalldataEnforcer: address(0x44), TimestampEnforcer: address(0x45), RedeemerEnforcer: address(0x46),
    },
};

const memoryStore = (): KeyStore & {map: Map<string, string>} => {
    const map = new Map<string, string>();
    return {map, getItem: key => map.get(key) ?? null, setItem: (key, value) => {map.set(key, value);}};
};

/** An in-process JSON-RPC node: no network, every body recorded. */
function fakeRpc() {
    const bodies: string[] = [];
    const raw: Hex[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
        const body = String(init?.body ?? "");
        bodies.push(body);
        const answer = (call: {id: number; method: string; params?: unknown[]}) => {
            const result = (() => {
                switch (call.method) {
                    case "eth_chainId": return toHex(giwaSepolia.id);
                    case "eth_blockNumber": return "0x10";
                    case "eth_getTransactionCount": return "0x3";
                    case "eth_estimateGas": return "0x5208";
                    case "eth_gasPrice": return "0x3b9aca00";
                    case "eth_maxPriorityFeePerGas": return "0x1";
                    case "eth_getBlockByNumber": return {number: "0x10", baseFeePerGas: "0x100", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1", transactions: []};
                    case "eth_getBalance": return "0xde0b6b3a7640000";
                    case "eth_sendRawTransaction": {const tx = call.params![0] as Hex; raw.push(tx); return keccak256(tx);}
                    default: throw new Error(`unexpected ${call.method}`);
                }
            })();
            return {jsonrpc: "2.0", id: call.id, result};
        };
        const parsed = JSON.parse(body);
        return new Response(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)), {headers: {"content-type": "application/json"}});
    }) as typeof fetch;
    return {bodies, raw, fetchFn};
}

const accept: BrowserKeyConfirm = async () => true;
const json = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v);

function setup(confirm: BrowserKeyConfirm = accept, store = memoryStore()) {
    const node = fakeRpc();
    const seen: BrowserKeyRequest[] = [];
    const provider = createBrowserKeyProvider({store, chain: giwaSepolia, rpcUrl: "https://rpc.invalid", fetchFn: node.fetchFn, confirm: async request => {seen.push(request); return confirm(request);}});
    return {...node, store, provider, seen};
}

async function connected(confirm?: BrowserKeyConfirm) {
    const ctx = setup(confirm);
    const [owner] = await ctx.provider.request({method: "eth_requestAccounts"}) as Address[];
    return {...ctx, owner: owner!};
}

const siwe = (owner: Address) => createSiweMessage({
    domain: "mapae.io", address: owner, uri: "https://mapae.io/arcade", version: "1", chainId: giwaSepolia.id,
    nonce: "abcdef12345678", issuedAt: new Date("2026-11-03T00:00:00Z"), statement: "Sign in to Mapae",
});

describe("browser-key provider", () => {
    test("(a) a root delegation signed with eth_signTypedData_v4 passes validateAccountBootstrap", async () => {
        const {provider, owner, seen} = await connected();
        const delegator = (await ownerPayerAccount(environment, owner)).address;
        const unsigned = preparePeriodDelegation({environment, delegator, delegate: address(0x51), policy: buildD3Policies(address(0x52))["open-agent"], startDate: 2_000_000_000});
        const typed = buildRootDelegationTypedData(environment.DelegationManager, unsigned);
        const signature = await provider.request({method: "eth_signTypedData_v4", params: [owner, json(typed)]}) as Hex;
        const delegation = withDelegationSignature(unsigned, signature);
        const validated = await validateAccountBootstrap({permissionContext: encodeDelegations([delegation])}, {environment, approval: buildSponsoredBootstrapApproval(FRAMEWORK_COMPOSITION_ID)});
        expect(validated.owner).toBe(owner);
        expect(validated.account).toBe(delegator);
        expect(seen[0]).toEqual({kind: "typed", primaryType: "Delegation", verifyingContract: environment.DelegationManager});
    });

    test("(b) personal_sign of an EIP-4361 message verifies against the connector's address", async () => {
        const {provider, owner, seen} = await connected();
        const message = siwe(owner);
        const signature = await provider.request({method: "personal_sign", params: [stringToHex(message), owner]}) as Hex;
        expect(await verifyMessage({address: owner, message, signature})).toBe(true);
        expect(seen[0]).toMatchObject({kind: "message", domain: "mapae.io", uri: "https://mapae.io/arcade"});
    });

    test("(c) eth_sendTransaction signs locally for chain 91342 and sends the raw transaction", async () => {
        const {provider, owner, raw, seen} = await connected();
        const to = address(0xbeef);
        const hash = await provider.request({method: "eth_sendTransaction", params: [{from: owner, to, value: toHex(parseEther("0.0005"))}]});
        expect(raw).toHaveLength(1);
        expect(hash).toBe(keccak256(raw[0]!));
        const tx = parseTransaction(raw[0]! as TransactionSerialized);
        expect(tx.chainId).toBe(91342);
        expect(tx.to).toBe(to.toLowerCase() as Address);
        expect(tx.value).toBe(parseEther("0.0005"));
        expect(await recoverTransactionAddress({serializedTransaction: raw[0]! as TransactionSerialized})).toBe(owner);
        expect(seen[0]).toEqual({kind: "transaction", to, valueEth: "0.0005"});
    });

    test("(d) eth_chainId is 0x164ce; switching to 91342 is a no-op and anything else is 4902", async () => {
        const {provider} = setup();
        expect(await provider.request({method: "eth_chainId"})).toBe("0x164ce");
        expect(await provider.request({method: "wallet_switchEthereumChain", params: [{chainId: "0x164ce"}]})).toBeNull();
        await expect(provider.request({method: "wallet_switchEthereumChain", params: [{chainId: "0x1"}]})).rejects.toMatchObject({code: 4902});
    });

    test("only allowlisted read-only methods are forwarded; sending and signing-shaped methods are refused unforwarded", async () => {
        const {provider, bodies, owner, seen} = await connected(async () => false);
        expect(await provider.request({method: "eth_getBalance", params: [owner, "latest"]})).toBe("0xde0b6b3a7640000");
        expect(bodies).toHaveLength(1);
        const refused = [
            {method: "eth_sendRawTransaction", params: ["0x02f86c"]},
            {method: "personal_sendTransaction", params: [{from: owner, to: address(0xbeef), value: "0x1"}, "pw"]},
            {method: "eth_sign", params: [owner, "0x00"]},
            {method: "eth_signTransaction", params: [{}]},
            {method: "eth_signTypedData_v3", params: [owner, "{}"]},
            {method: "eth_sendUserOperation", params: [{}]},
            {method: "wallet_sendCalls", params: [{}]},
            {method: "wallet_addEthereumChain", params: [{}]},
            {method: "personal_unlockAccount", params: [owner, "pw"]},
            {method: "eth_subscribe", params: ["newHeads"]},
            {method: "something_unknown"},
        ];
        for (const call of refused) await expect(provider.request(call)).rejects.toMatchObject({code: 4200});
        expect(bodies).toHaveLength(1);
        expect(seen).toHaveLength(0);
    });

    test("(f) a declined confirm rejects every signing method with 4001 and sends nothing", async () => {
        const {provider, owner, bodies} = await connected(async () => false);
        const calls = [
            {method: "personal_sign", params: [stringToHex(siwe(owner)), owner]},
            {method: "eth_signTypedData_v4", params: [owner, json({domain: {verifyingContract: address(0x11)}, types: {Mail: [{name: "a", type: "uint256"}]}, primaryType: "Mail", message: {a: "1"}})]},
            {method: "eth_sendTransaction", params: [{from: owner, to: address(0xbeef), value: "0x1"}]},
        ];
        for (const call of calls) await expect(provider.request(call)).rejects.toMatchObject({code: 4001});
        expect(bodies).toHaveLength(0);
    });

    test("(g) the private key appears in no RPC body and no provider result; only export returns it", async () => {
        const {provider, owner, bodies, store} = await connected();
        const key = store.map.get(BROWSER_KEY_STORAGE_KEY)!;
        expect(key).toMatch(/^0x[0-9a-f]{64}$/);
        const results = [
            await provider.request({method: "eth_chainId"}),
            await provider.request({method: "eth_accounts"}),
            await provider.request({method: "eth_requestAccounts"}),
            await provider.request({method: "personal_sign", params: [stringToHex(siwe(owner)), owner]}),
            await provider.request({method: "eth_sendTransaction", params: [{from: owner, to: address(0xbeef), value: "0x1"}]}),
            await provider.request({method: "eth_getBalance", params: [owner, "latest"]}),
        ];
        const bare = key.slice(2).toLowerCase();
        for (const text of [...bodies, ...results.map(r => JSON.stringify(r))]) expect(text.toLowerCase()).not.toContain(bare);
        expect(bodies.length).toBeGreaterThan(0);
        expect(exportBrowserKey(store)).toBe(key as Hex);
    });
});

describe("browser-key connector", () => {
    const instance = (store: KeyStore, fetchFn = fakeRpc().fetchFn) =>
        browserKey({store: () => store, confirm: accept, rpcUrl: "https://rpc.invalid", fetchFn})({chains: [giwaSepolia], emitter: {emit() {}} as never, providers: [], storage: null});

    test("(e) id, chain, and one key per storage: the same store yields the same address, an empty one a new key", async () => {
        const store = memoryStore();
        const first = instance(store);
        expect(first.id).toBe("browser-key");
        expect(await first.isAuthorized()).toBe(false);
        expect(await first.getAccounts()).toEqual([]);
        const {accounts, chainId} = await first.connect();
        expect(chainId).toBe(91342);
        expect(store.map.size).toBe(1);
        expect(await first.isAuthorized()).toBe(true);
        await first.disconnect();
        expect(store.map.has(BROWSER_KEY_STORAGE_KEY)).toBe(true);
        const again = await instance(store).connect();
        expect(again.accounts).toEqual(accounts);
        const fresh = await instance(memoryStore()).connect();
        expect(fresh.accounts[0]).not.toBe(accounts[0]);
    });
});
