// Subpath imports on purpose: the package barrel also exports the Bun-only agent
// runtime, which must never reach a browser bundle.
import {parseActiveDeploymentArtifactJson} from "@mapae/delegation/config";
import {giwaSepolia, parseNodeRpcUrl} from "@mapae/shared";
import {createPublicClient, defineChain, http, isHex} from "viem";
import type {Hex, PublicClient} from "viem";
import frameworkArtifact from "../../../deployments/giwa-sepolia.framework.json";

/**
 * The committed deployment artifact is the source of truth for enforcer and
 * manager addresses — the console never carries its own copy of them.
 */
export const deployment = parseActiveDeploymentArtifactJson(JSON.stringify(frameworkArtifact));

const PUBLIC_GIWA_HOST = new URL(giwaSepolia.rpcUrls.default.http[0]).hostname;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

/**
 * Refuse any endpoint that is neither the public GIWA RPC nor loopback.
 *
 * This is not a connectivity check — it is a secrets guard, and it belongs here rather
 * than in `parseNodeRpcUrl` because it is specific to being a browser app. Vite inlines
 * every `import.meta.env.VITE_*` into the built JavaScript at build time, so whatever is
 * in `VITE_RPC_URL` is published verbatim to every visitor. Private RPC endpoints
 * authenticate by putting an API key in the URL — usually in the path, where
 * `parseNodeRpcUrl`'s userinfo check cannot see it — so pointing this console at one
 * would ship that key inside `dist/`.
 *
 * The two legitimate targets are both non-secret: the public GIWA endpoint, or a local
 * fork. Refusing at module load fails `bun run build:console` loudly instead of
 * producing a bundle that looks fine and contains a credential.
 */
export function assertPublishableRpc(value: string): string {
    const {hostname} = new URL(value);
    if (hostname === PUBLIC_GIWA_HOST || LOOPBACK_HOSTS.includes(hostname)) return value;
    throw new Error(
        `VITE_RPC_URL must be the public GIWA endpoint (${PUBLIC_GIWA_HOST}) or loopback, got "${hostname}". ` +
            "Vite inlines this value into the shipped bundle, so a private or keyed RPC URL " +
            "here would be published to every visitor. Keep private endpoints in a server-side " +
            "GIWA_SEPOLIA_RPC_URL instead.",
    );
}

/**
 * Point the console at a local fork for verification, or at GIWA to read live
 * state. Reads only: nothing in this app broadcasts.
 */
export const rpcUrl = assertPublishableRpc(
    parseNodeRpcUrl(import.meta.env.VITE_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0]),
);

const isLocal = new URL(rpcUrl).hostname !== PUBLIC_GIWA_HOST;

export const chain = isLocal
    ? defineChain({
          id: giwaSepolia.id,
          name: "GIWA fork",
          nativeCurrency: giwaSepolia.nativeCurrency,
          rpcUrls: {default: {http: [rpcUrl]}},
          blockExplorers: giwaSepolia.blockExplorers,
      })
    : giwaSepolia;

export const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
}) as PublicClient;

/**
 * Where a signed revocation is sent. Absent means the revoke button stays disabled.
 *
 * Loopback only, and not for the same reason as `VITE_RPC_URL`. The submitter holds a
 * funded relayer key and has no application authentication — the same trust boundary the
 * facilitator lives behind. Allowing a remote origin here would let a page point an
 * owner's signature at somebody else's submitter, and would also mean the browser sending
 * a bearer-grade authorization across the network. The value is not a secret; the
 * restriction is about where authority is allowed to travel.
 */
export function configuredSubmitterUrl(): string | undefined {
    const raw = import.meta.env.VITE_REVOCATION_SUBMITTER_URL?.trim();
    if (!raw) return undefined;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("VITE_REVOCATION_SUBMITTER_URL is not a valid URL");
    }
    if (!LOOPBACK_HOSTS.includes(url.hostname)) {
        throw new Error(
            `VITE_REVOCATION_SUBMITTER_URL must be loopback, got "${url.hostname}". ` +
                "The submitter has no application authentication and holds a funded relayer key; " +
                "put a TLS reverse proxy in front of it before it is reachable remotely.",
        );
    }
    return url.origin;
}

/**
 * The root permission this console inspects. A wallet-embedded build would
 * enumerate the connected account's delegations; for the demo the signed
 * open-agent permission is supplied by configuration.
 */
export function configuredPermissionContext(): Hex | undefined {
    const value = import.meta.env.VITE_PERMISSION_CONTEXT?.trim();
    return value && isHex(value) && value.length > 2 ? (value as Hex) : undefined;
}

/**
 * Receipts need an explicit window because GIWA rejects `eth_getLogs` spans wider
 * than 100k blocks; a silent cap would present truncated history as complete.
 *
 * Parsed rather than cast: `BigInt("abc")` throws at module load and renders a
 * blank page with no hint of which variable was wrong, and a negative value would
 * quietly produce a `fromBlock` past the head.
 */
function parseLookbackBlocks(raw: string | undefined): bigint {
    const value = raw?.trim();
    if (!value) return 50_000n;
    if (!/^\d+$/.test(value) || value === "0") {
        throw new Error(
            `VITE_RECEIPT_LOOKBACK_BLOCKS must be a positive integer block count, got "${value}"`,
        );
    }
    return BigInt(value);
}

export const RECEIPT_LOOKBACK_BLOCKS = parseLookbackBlocks(
    import.meta.env.VITE_RECEIPT_LOOKBACK_BLOCKS,
);
