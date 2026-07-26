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

/**
 * Does this hostname reach a node on this machine?
 *
 * The single classifier behind every loopback decision in the repo. It used to be a
 * three-entry list (`localhost`, `127.0.0.1`, `[::1]`) copied into five files, and the
 * list was under-inclusive in a way that mattered in exactly one direction.
 *
 * The two directions are not symmetric. A guard that demands loopback (the e2e runners,
 * which must never broadcast) fails *safe* when the list is short: an unlisted local
 * address is refused, and the run stops. A guard that demands the live chain (the GIWA
 * preflight and run, whose whole output is evidence) fails *dangerous*: an unrecognised
 * local address is classified as GIWA, and a fork produces a passing evidence file.
 *
 * So the whole 127.0.0.0/8 block counts, not just `.1` — binding several Anvils to
 * distinct loopback addresses is an ordinary thing to do. `0.0.0.0` counts because as a
 * destination it reaches local services. `*.localhost` counts because RFC 6761 reserves
 * it for exactly that, and IPv4-mapped IPv6 counts because it is the same address
 * wearing a different notation.
 */
export function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return true;

    // `new URL()` keeps IPv6 literals bracketed; accept either form.
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (bare === "::1") return true;
    // ::ffff:127.0.0.1 — the same loopback address in IPv4-mapped notation.
    const mapped = /^::ffff:(.+)$/.exec(bare);
    if (mapped?.[1]) return isLoopbackHost(mapped[1]);

    const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
    if (!octets) return false;
    const parts = octets.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    return parts[0] === 127 || bare === "0.0.0.0";
}

/** Which chain a command is allowed to talk to. */
export type RpcTarget = "loopback" | "live";

/**
 * Refuse to proceed unless the endpoint is the kind of node this command needs.
 *
 * Both directions are safety guards, and each is the other's mirror:
 *
 * - `"loopback"` — the e2e runners (`mcp-e2e.ts`, `revocation-submitter-e2e.ts`). Their
 *   children inherit `.env` files that point at real GIWA, so a missed override would
 *   settle a real transaction. This is the last thing standing between a test run and a
 *   broadcast.
 * - `"live"` — the GIWA preflight and run. Their entire product is evidence about the
 *   real chain, and evidence taken against a fork is not evidence, it is a false GO.
 *
 * `because` is appended so each call site keeps its own reason. The mechanism is shared;
 * the explanation of why *this* command cares is not, and collapsing them into one
 * message would delete the part a reader actually needs.
 */
export function assertRpcTarget(value: string, expect: RpcTarget, because: string): string {
    const normalized = parseNodeRpcUrl(value);
    const {hostname} = new URL(normalized);
    const loopback = isLoopbackHost(hostname);
    if (expect === "loopback" && !loopback) {
        throw new Error(`refusing to run: ${hostname} is not loopback — ${because}`);
    }
    if (expect === "live" && loopback) {
        throw new Error(`refusing to run: ${hostname} is loopback — ${because}`);
    }
    return normalized;
}

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
    if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
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
