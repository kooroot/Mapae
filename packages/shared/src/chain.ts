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

export function explorerTxUrl(hash: string): string {
    return `${giwaSepolia.blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
    return `${giwaSepolia.blockExplorers.default.url}/address/${address}`;
}
