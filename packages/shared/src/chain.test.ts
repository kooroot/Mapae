import {describe, expect, test} from "bun:test";
import {GIWA_SEPOLIA_CAIP2, giwaSepolia, parseNodeRpcUrl} from "./chain.js";

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

describe("GIWA chain constants", () => {
    test("CAIP-2 id is derived from the chain, not hardcoded twice", () => {
        expect(GIWA_SEPOLIA_CAIP2).toBe(`eip155:${giwaSepolia.id}`);
        expect(giwaSepolia.id).toBe(91342);
    });
});
