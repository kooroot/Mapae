import {defineChain} from "viem";

/**
 * GIWA Sepolia — Upbit's OP Stack L2, settling to Ethereum Sepolia.
 *
 * Chain ID and RPC come from the official network parameters:
 * https://docs.giwa.io/giwa-chain/en/get-started/connect-to-giwa
 */
export const giwaSepolia = defineChain({
    id: 91342,
    name: "GIWA Sepolia",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {
        default: {http: ["https://sepolia-rpc.giwa.io"]},
    },
    blockExplorers: {
        default: {
            name: "GIWA Explorer",
            url: "https://sepolia-explorer.giwa.io",
        },
    },
    testnet: true,
});

/** CAIP-2 identifier. x402 v2 uses this form for `network`, not the chain name. */
export const GIWA_SEPOLIA_CAIP2 = `eip155:${giwaSepolia.id}` as const;

/** Self-hosted facilitator. Override via env in deployed environments. */
export const FACILITATOR_URL = "http://localhost:8080";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Validate a node RPC endpoint for the payment path (seller, facilitator, agent).
 *
 * HTTPS is required for any remote host — the RPC answers the deployment-integrity
 * reads, so a MITM there could lie about which contracts are deployed. Loopback is
 * exempt because it has no network to intercept, and because that exemption is what
 * lets the whole payment path be verified against a local Anvil fork. Forbidding it
 * would leave the real GIWA RPC as the only way to run the apps, which would settle
 * real transactions on-chain just to test them.
 *
 * Deployment tooling under apps/delegation-lab deliberately keeps its own
 * HTTPS-only check: those commands broadcast to GIWA and must never target a fork.
 */
export function parseNodeRpcUrl(value: string): string {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("RPC URL must be HTTP(S) without embedded credentials");
    }
    if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
        throw new Error("RPC URL must use HTTPS unless it is loopback");
    }
    return url.toString();
}

export function explorerTxUrl(hash: string): string {
    return `${giwaSepolia.blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
    return `${giwaSepolia.blockExplorers.default.url}/address/${address}`;
}
