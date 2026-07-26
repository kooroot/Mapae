import {describe, expect, test} from "bun:test";
import {
    GIWA_SEPOLIA_CAIP2,
    assertRpcTarget,
    giwaSepolia,
    isLoopbackHost,
    parseNodeRpcUrl,
} from "./chain.js";

describe("parseNodeRpcUrl", () => {
    test("accepts HTTPS endpoints", () => {
        expect(parseNodeRpcUrl("https://sepolia-rpc.giwa.io")).toBe(
            "https://sepolia-rpc.giwa.io/",
        );
    });

    test("accepts loopback HTTP so the payment path can run against a local fork", () => {
        for (const value of [
            "http://127.0.0.1:8545",
            "http://localhost:8545",
            "http://[::1]:8545",
        ]) {
            expect(parseNodeRpcUrl(value)).toContain("8545");
        }
    });

    test("still rejects plaintext HTTP to a remote host", () => {
        // The loopback exemption must not become a general HTTP allowance: a remote
        // plaintext RPC could lie about which contracts are deployed.
        for (const value of [
            "http://sepolia-rpc.giwa.io",
            "http://10.0.0.5:8545",
            "http://evil.example.com",
            // Not loopback despite the substring — hostname is the whole label.
            "http://127.0.0.1.example.com:8545",
        ]) {
            expect(() => parseNodeRpcUrl(value)).toThrow("HTTPS unless it is loopback");
        }
    });

    test("rejects embedded credentials and non-HTTP schemes", () => {
        expect(() => parseNodeRpcUrl("https://user:pass@rpc.example.com")).toThrow(
            "without embedded credentials",
        );
        expect(() => parseNodeRpcUrl("wss://rpc.example.com")).toThrow(
            "without embedded credentials",
        );
        expect(() => parseNodeRpcUrl("file:///etc/passwd")).toThrow(
            "without embedded credentials",
        );
    });
});

/**
 * The classifier behind every loopback decision in the repo.
 *
 * It is worth this much pinning because the two guards built on it fail in opposite
 * directions: demanding loopback fails safe when the classifier is too narrow (a local
 * node is refused, the run stops), while demanding the live chain fails *dangerous* —
 * an unrecognised local address is read as GIWA and a fork produces passing evidence.
 */
describe("isLoopbackHost", () => {
    test("recognises the whole 127.0.0.0/8 block, not just .1", () => {
        // Binding several Anvils to distinct loopback addresses is ordinary. The
        // three-entry list this replaced knew only 127.0.0.1, so a fork on 127.0.0.2
        // would have been classified as the live chain.
        for (const host of ["127.0.0.1", "127.0.0.2", "127.1.2.3", "127.255.255.254"]) {
            expect(isLoopbackHost(host)).toBe(true);
        }
    });

    test("recognises localhost, its subdomains, and IPv6 in both notations", () => {
        for (const host of [
            "localhost",
            "LOCALHOST",
            "anvil.localhost", // RFC 6761 reserves the whole suffix for this
            "[::1]",
            "::1",
            "[::ffff:127.0.0.1]", // the same address, IPv4-mapped
            "0.0.0.0", // as a destination this reaches local services
        ]) {
            expect(isLoopbackHost(host)).toBe(true);
        }
    });

    test("does not mistake a remote host that merely looks local", () => {
        for (const host of [
            "sepolia-rpc.giwa.io",
            "10.0.0.5", // private, but a different machine
            "128.0.0.1", // one octet away from the block
            "27.0.0.1",
            "126.255.255.255",
            "127.0.0.1.example.com", // substring, not the hostname
            "notlocalhost",
            "localhost.evil.com", // suffix match must be on the label, not the string
            "999.0.0.1", // not a valid address at all
        ]) {
            expect(isLoopbackHost(host)).toBe(false);
        }
    });
});

describe("assertRpcTarget", () => {
    test("'live' refuses a fork — evidence taken against one is a false GO", () => {
        expect(() => assertRpcTarget("http://127.0.0.1:8546", "live", "because")).toThrow(
            "is loopback",
        );
        expect(() => assertRpcTarget("http://127.0.0.2:8546", "live", "because")).toThrow(
            "is loopback",
        );
    });

    test("'loopback' refuses the real chain — this is the last stop before a broadcast", () => {
        expect(() => assertRpcTarget("https://sepolia-rpc.giwa.io", "loopback", "because")).toThrow(
            "is not loopback",
        );
    });

    test("each direction accepts what it is for", () => {
        expect(assertRpcTarget("https://sepolia-rpc.giwa.io", "live", "x")).toContain("giwa.io");
        expect(assertRpcTarget("http://127.0.0.1:8546", "loopback", "x")).toContain("8546");
    });

    test("the caller's reason survives into the message", () => {
        // The mechanism is shared; why *this* command cares is not. Collapsing the two
        // into one message would delete the part a reader needs.
        expect(() => assertRpcTarget("http://localhost:1", "live", "a fork is not evidence")).toThrow(
            "a fork is not evidence",
        );
    });

    test("still applies the credential and scheme checks underneath", () => {
        expect(() => assertRpcTarget("https://user:pass@rpc.example.com", "live", "x")).toThrow(
            "without embedded credentials",
        );
        expect(() => assertRpcTarget("http://evil.example.com", "live", "x")).toThrow(
            "HTTPS unless it is loopback",
        );
    });
});

describe("GIWA chain constants", () => {
    test("CAIP-2 id is derived from the chain, not hardcoded twice", () => {
        expect(GIWA_SEPOLIA_CAIP2).toBe(`eip155:${giwaSepolia.id}`);
        expect(giwaSepolia.id).toBe(91342);
    });
});
