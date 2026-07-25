import {describe, expect, test} from "bun:test";
import {
    describe as describeError,
    httpStatusFor,
    isRetryable,
    redactForLog,
    redactUrls,
} from "./errors.js";
import type {SettlementError} from "./errors.js";

const ADDRESS = "0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382" as const;
const TX_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
/** Stands in for a signed permission context: far longer than any hash. */
const BEARER = `0x${"cd".repeat(400)}`;

describe("redactForLog", () => {
    test("keeps a revert reason, which is the whole point of logging at all", () => {
        const line = redactForLog(
            new Error("execution reverted: ERC20PeriodTransferEnforcer:transfer-amount-exceeded"),
        );
        expect(line).toContain("ERC20PeriodTransferEnforcer:transfer-amount-exceeded");
    });

    test("redacts a bearer-length hex blob but keeps addresses and tx hashes", () => {
        const line = redactForLog(
            new Error(`revert for ${ADDRESS} in ${TX_HASH} with data ${BEARER}`),
            5_000,
        );
        expect(line).not.toContain(BEARER);
        expect(line).toContain("400 bytes redacted");
        // Both are public identifiers an operator needs to look the failure up.
        expect(line).toContain(ADDRESS);
        expect(line).toContain(TX_HASH);
    });

    test("an RPC URL is reduced to its host — the path is a provider API key", () => {
        // The realistic shape. Nothing about this string looks like a credential, and the
        // repo's URL validator (parseNodeRpcUrl) only rejects userinfo, so it passes every
        // other check. viem embeds its transport URL in errors and this function feeds
        // HTTP response bodies, so it is the last thing between the key and a client.
        const line = redactForLog(
            new Error("HTTP request failed. URL: https://giwa-sepolia.example.io/SECRET-KEY-123"),
            5_000,
        );
        expect(line).not.toContain("SECRET-KEY-123");
        // The host survives: which endpoint failed is the entire diagnostic value.
        expect(line).toContain("giwa-sepolia.example.io");
        expect(line).toContain("<redacted>");
    });

    test("a bearer blob cannot survive by hiding inside a longer message", () => {
        const viemShaped = new Error(
            [
                "The contract function reverted.",
                `Args: (${BEARER}, 1000000)`,
                "Docs: https://viem.sh",
            ].join("\n"),
        );
        expect(redactForLog(viemShaped, 5_000)).not.toContain("cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd");
    });

    test("collapses to one line and bounds the length", () => {
        const line = redactForLog(new Error(`a\n b\tc${"!".repeat(1_000)}`));
        expect(line).not.toContain("\n");
        expect(line.length).toBeLessThanOrEqual(301); // 300 plus the ellipsis
    });

    test("survives a non-Error being thrown", () => {
        expect(redactForLog("plain string")).toBe("plain string");
        expect(redactForLog(undefined)).toBe("undefined");
    });
});

describe("settlement error model", () => {
    // The tags map onto Data.TaggedError for a later Effect migration, so the
    // status mapping and message shape are a contract, not incidental formatting.
    test("operator-facing failures page with 503 rather than blaming the caller", () => {
        const outOfGas: SettlementError = {
            _tag: "RelayerOutOfGas",
            signer: ADDRESS,
            balance: 0n,
        };
        expect(httpStatusFor(outOfGas)).toBe(503);
        expect(isRetryable({_tag: "RpcRateLimited", url: "https://rpc"})).toBe(true);
        expect(isRetryable(outOfGas)).toBe(false);
    });

    test("caller-facing failures keep distinct statuses", () => {
        expect(httpStatusFor({_tag: "MalformedPayload", field: "amount"})).toBe(400);
        expect(httpStatusFor({_tag: "InvalidSignature", expectedSigner: ADDRESS})).toBe(401);
        expect(httpStatusFor({_tag: "DelegationRevoked", delegationHash: TX_HASH})).toBe(403);
        expect(httpStatusFor({_tag: "NonceAlreadyUsed", authorizer: ADDRESS, nonce: TX_HASH})).toBe(
            409,
        );
        expect(httpStatusFor({_tag: "TxReverted"})).toBe(422);
    });

    test("DomainMismatch stays separate from InvalidSignature", () => {
        // Collapsing these sends whoever reads the log looking in the wrong place.
        const domain = describeError({
            _tag: "DomainMismatch",
            expected: "Mock USDC",
            received: "USDC",
        });
        expect(domain).toContain("domain mismatch");
        expect(domain).not.toContain("signature");
    });
});

describe("redactUrls", () => {
    test("keeps the origin and drops path, query and fragment", () => {
        expect(redactUrls("https://host.example.io/KEY123")).toBe("https://host.example.io/<redacted>");
        expect(redactUrls("https://host.example.io/KEY123?x=1#f")).toBe(
            "https://host.example.io/<redacted>",
        );
        expect(redactUrls("https://host.example.io:8545/KEY")).toBe(
            "https://host.example.io:8545/<redacted>",
        );
    });

    test("a bare origin is left recognisable, not mangled", () => {
        // The public GIWA endpoint has no path. Rewriting it to "…/<redacted>" would
        // suggest a secret was removed when there was none.
        expect(redactUrls("https://sepolia-rpc.giwa.io")).toBe("https://sepolia-rpc.giwa.io");
        expect(redactUrls("https://sepolia-rpc.giwa.io/")).toBe("https://sepolia-rpc.giwa.io");
        expect(redactUrls("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545");
    });

    test("every URL in a multi-line blob is redacted, not just the first", () => {
        // anvil's stderr is multi-line and repeats the endpoint.
        const anvil = [
            "Failed to get latest block from https://a.example.io/KEY-A",
            "backend error: https://a.example.io/KEY-A returned 429",
            "context: fork url https://b.example.io/KEY-B",
        ].join("\n");
        const out = redactUrls(anvil);
        expect(out).not.toContain("KEY-A");
        expect(out).not.toContain("KEY-B");
        expect(out).toContain("a.example.io");
        expect(out).toContain("b.example.io");
    });

    test("surrounding punctuation is not swallowed into the URL", () => {
        expect(redactUrls('fetch("https://h.example.io/KEY") failed')).toBe(
            'fetch("https://h.example.io/<redacted>") failed',
        );
        expect(redactUrls("see (https://h.example.io/KEY)")).toBe(
            "see (https://h.example.io/<redacted>)",
        );
    });

    test("text with no URL is returned unchanged", () => {
        const plain = "ERC20PeriodTransferEnforcer:transfer-amount-exceeded";
        expect(redactUrls(plain)).toBe(plain);
    });
});
