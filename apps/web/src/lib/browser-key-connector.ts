import {createConnector} from "wagmi";
import {createWalletClient, formatEther, getAddress, hexToString, http, isHex, numberToHex, type Address, type Chain, type Hex, type HttpTransportConfig, type TypedDataDefinition} from "viem";
import {generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount} from "viem/accounts";
import {parseSiweMessage} from "viem/siwe";
import {chain as giwaChain, rpcUrl as giwaRpcUrl} from "./config";

/**
 * "Play without installing": one secp256k1 key generated on this device.
 *
 * The key lives under {@link BROWSER_KEY_STORAGE_KEY} in this origin's localStorage as the
 * 0x-prefixed 32-byte hex and nothing else. It leaves the device only as signatures and
 * signed transactions; the one path that returns it is {@link exportBrowserKey}, behind the
 * picker's confirm. Every signature waits on the injected {@link BrowserKeyConfirm}: a declined request
 * rejects with 4001 and nothing reaches the RPC. GIWA Sepolia test assets only — any script
 * on this origin could read the key, which is acceptable for test assets and nothing more.
 */
export const BROWSER_KEY_STORAGE_KEY = "mapae.browser-key.v1";

export type KeyStore = Pick<Storage, "getItem" | "setItem">;

/** What the in-page dialog shows before anything is signed or sent. */
export type BrowserKeyRequest =
    | {kind: "message"; domain?: string; uri?: string; message: string}
    | {kind: "typed"; primaryType: string; verifyingContract?: string}
    | {kind: "transaction"; to?: string; valueEth: string};

export type BrowserKeyConfirm = (request: BrowserKeyRequest) => Promise<boolean>;

type RequestArgs = {method: string; params?: unknown};
export type BrowserKeyProvider = {
    request(args: RequestArgs): Promise<unknown>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
};

export function rpcError(code: number, message: string): Error & {code: number} {
    return Object.assign(new Error(message), {code});
}

const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/**
 * The only methods forwarded to the RPC: reads that neither sign nor send. Anything else
 * (eth_sendRawTransaction, personal_sendTransaction, eth_sign, wallet_*, ...) is refused with 4200,
 * so no request can reach the network without passing the confirm above.
 */
const READ_ONLY = new Set([
    "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_feeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas",
    "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount", "eth_getLogs",
    "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt",
    "eth_getBlockTransactionCountByNumber", "eth_getBlockTransactionCountByHash", "eth_syncing", "web3_clientVersion",
]);

function storedKey(store: KeyStore | undefined): Hex | undefined {
    const value = store?.getItem(BROWSER_KEY_STORAGE_KEY) ?? undefined;
    return value && KEY_PATTERN.test(value) ? value as Hex : undefined;
}

/** The stored key, for the export action only. `undefined` when this browser holds none. */
export function exportBrowserKey(store: KeyStore | undefined = browserStorage()): Hex | undefined {
    return storedKey(store);
}

function browserStorage(): KeyStore | undefined {
    try {return typeof localStorage === "undefined" ? undefined : localStorage;}
    catch {return undefined;}
}

/** A hex quantity as a bigint; `undefined` when absent. */
const quantity = (value: unknown) => typeof value === "string" && isHex(value) ? BigInt(value) : undefined;

export function createBrowserKeyProvider({store, confirm, chain = giwaChain, rpcUrl = giwaRpcUrl, fetchFn}: {
    store: KeyStore | undefined; confirm: BrowserKeyConfirm; chain?: Chain; rpcUrl?: string; fetchFn?: HttpTransportConfig["fetchFn"];
}): BrowserKeyProvider {
    const transport = http(rpcUrl, {fetchFn, retryCount: 0});
    const rpc = transport({chain});
    let cached: {key: Hex; account: PrivateKeyAccount} | undefined;
    const account = (create: boolean): PrivateKeyAccount | undefined => {
        let key = storedKey(store);
        if (!key && create) {
            if (!store) throw rpcError(4100, "This browser cannot keep a key");
            key = generatePrivateKey();
            store.setItem(BROWSER_KEY_STORAGE_KEY, key);
        }
        if (!key) return undefined;
        if (cached?.key !== key) cached = {key, account: privateKeyToAccount(key)};
        return cached.account;
    };
    const signer = (from: unknown): PrivateKeyAccount => {
        const owner = account(false);
        if (!owner) throw rpcError(4100, "Not connected");
        if (typeof from === "string" && getAddress(from) !== owner.address) throw rpcError(4100, "Unknown account");
        return owner;
    };
    const approve = async (request: BrowserKeyRequest) => {
        if (!await confirm(request)) throw rpcError(4001, "User rejected the request");
    };
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    return {
        on(event, listener) {(listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);},
        removeListener(event, listener) {listeners.get(event)?.delete(listener);},
        async request({method, params}) {
            const args = Array.isArray(params) ? params : [];
            switch (method) {
                case "eth_chainId": return numberToHex(chain.id);
                case "net_version": return String(chain.id);
                case "eth_accounts": {const owner = account(false); return owner ? [owner.address] : [];}
                case "eth_requestAccounts": return [account(true)!.address];
                case "wallet_switchEthereumChain": {
                    const target = (args[0] as {chainId?: string} | undefined)?.chainId;
                    if (target !== undefined && quantity(target) === BigInt(chain.id)) return null;
                    throw rpcError(4902, `Only ${chain.name} (${chain.id}) is available with this browser key`);
                }
                case "personal_sign": {
                    const owner = signer(args[1]);
                    const raw = args[0] as Hex;
                    const message = isHex(raw) ? hexToString(raw) : String(raw);
                    const siwe = parseSiweMessage(message);
                    await approve({kind: "message", domain: siwe.domain, uri: siwe.uri, message});
                    return owner.signMessage({message: isHex(raw) ? {raw} : message});
                }
                case "eth_signTypedData_v4": {
                    const owner = signer(args[0]);
                    const typed = (typeof args[1] === "string" ? JSON.parse(args[1]) : args[1]) as TypedDataDefinition & {domain?: {verifyingContract?: string}};
                    await approve({kind: "typed", primaryType: String(typed.primaryType), verifyingContract: typed.domain?.verifyingContract});
                    return owner.signTypedData(typed);
                }
                case "eth_sendTransaction": {
                    const tx = (args[0] ?? {}) as Record<string, unknown>;
                    const owner = signer(tx["from"]);
                    const value = quantity(tx["value"]) ?? 0n;
                    const to = typeof tx["to"] === "string" ? getAddress(tx["to"]) as Address : undefined;
                    await approve({kind: "transaction", to, valueEth: formatEther(value)});
                    const wallet = createWalletClient({account: owner, chain, transport});
                    const data = typeof tx["data"] === "string" ? tx["data"] as Hex : typeof tx["input"] === "string" ? tx["input"] as Hex : undefined;
                    return wallet.sendTransaction({
                        account: owner, chain, to, value, data,
                        gas: quantity(tx["gas"]), nonce: tx["nonce"] === undefined ? undefined : Number(quantity(tx["nonce"])),
                        ...(tx["maxFeePerGas"] !== undefined ? {maxFeePerGas: quantity(tx["maxFeePerGas"]), maxPriorityFeePerGas: quantity(tx["maxPriorityFeePerGas"])} : {}),
                    } as Parameters<typeof wallet.sendTransaction>[0]);
                }
                default:
                    if (!READ_ONLY.has(method)) throw rpcError(4200, `${method} is not supported by this browser key`);
                    return rpc.request({method, params} as never);
            }
        },
    };
}

/** Without a confirm, every signing request is declined. */
const declineAll: BrowserKeyConfirm = async () => false;

/**
 * The wagmi connector. `confirm` and `store` are injectable so tests run without a DOM; in the
 * app, `wagmi.ts` passes the in-page dialog and the store defaults to this origin's localStorage.
 */
export function browserKey(options: {confirm?: BrowserKeyConfirm; store?: () => KeyStore | undefined; rpcUrl?: string; fetchFn?: HttpTransportConfig["fetchFn"]} = {}) {
    return createConnector<BrowserKeyProvider>(config => {
        const chain = config.chains.find(c => c.id === giwaChain.id) ?? giwaChain;
        const store = () => options.store ? options.store() : browserStorage();
        let provider: BrowserKeyProvider | undefined;
        const getProvider = async () => provider ??= createBrowserKeyProvider({
            store: store(), chain, rpcUrl: options.rpcUrl ?? giwaRpcUrl, fetchFn: options.fetchFn,
            confirm: request => (options.confirm ?? declineAll)(request),
        });
        const disconnectedKey = "browser-key.disconnected";
        return {
            id: "browser-key",
            name: "브라우저 키 · Browser key",
            type: "browserKey",
            async connect(parameters) {
                const accounts = await (await getProvider()).request({method: "eth_requestAccounts"}) as Address[];
                await config.storage?.removeItem(disconnectedKey);
                return {accounts: (parameters?.withCapabilities ? accounts.map(address => ({address, capabilities: {}})) : accounts) as never, chainId: chain.id};
            },
            /** The key stays; only clearing site data removes it. */
            async disconnect() {await config.storage?.setItem(disconnectedKey, true);},
            async getAccounts() {return await (await getProvider()).request({method: "eth_accounts"}) as Address[];},
            async getChainId() {return chain.id;},
            getProvider,
            async isAuthorized() {
                if (await config.storage?.getItem(disconnectedKey)) return false;
                return !!storedKey(store());
            },
            async switchChain({chainId}) {
                await (await getProvider()).request({method: "wallet_switchEthereumChain", params: [{chainId: numberToHex(chainId)}]});
                return chain;
            },
            onAccountsChanged(accounts) {config.emitter.emit("change", {accounts: accounts.map(a => getAddress(a))});},
            onChainChanged(chainId) {config.emitter.emit("change", {chainId: Number(chainId)});},
            onDisconnect() {config.emitter.emit("disconnect");},
        };
    });
}
