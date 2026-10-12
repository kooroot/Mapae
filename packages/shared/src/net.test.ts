import {describe, expect, test} from "bun:test";
import {ipBucket, subnetBucket} from "./net.js";

describe("ipBucket", () => {
    test("an IPv4 address is its own bucket", () => {
        expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    });

    test("an IPv4-mapped IPv6 address is that IPv4 client, not the all-zero /64", () => {
        // Folding `::ffff:a.b.c.d` to its first four groups gives `0:0:0:0::/64` for
        // every IPv4 client there is — one shared window for all of them.
        expect(ipBucket("::ffff:203.0.113.5")).toBe("::ffff:203.0.113.5");
        expect(ipBucket("::ffff:203.0.113.5")).not.toBe(ipBucket("::ffff:198.51.100.7"));
        expect(ipBucket("::ffff:203.0.113.5")).not.toBe(ipBucket("::1"));
    });

    test("every address in one IPv6 /64 shares a bucket, so hopping addresses buys nothing", () => {
        expect(ipBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
        expect(ipBucket("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    });

    test("a different /64 is a different bucket", () => {
        expect(ipBucket("2001:db8:1:3::1")).not.toBe(ipBucket("2001:db8:1:2::1"));
    });

    test("the bucket does not depend on how the address was spelled", () => {
        expect(ipBucket("2001:0DB8:0001:0002:0000:0000:0000:0001")).toBe(ipBucket("2001:db8:1:2::1"));
        expect(ipBucket("2001:0db8:0001:0002:0003:0004:0005:0006")).toBe("2001:db8:1:2::/64");
    });

    test("a leading or trailing `::` expands from the right end", () => {
        expect(ipBucket("::1")).toBe("0:0:0:0::/64");
        expect(ipBucket("2001:db8::")).toBe("2001:db8:0:0::/64");
        expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
        expect(ipBucket("2001:db8:1:2:3::")).toBe("2001:db8:1:2::/64");
        expect(ipBucket("2001:db8::1:2:3:4:5")).toBe("2001:db8:0:1::/64");
    });
});

describe("subnetBucket", () => {
    test("an IPv4 address buckets as its /24, so a rented block shares one count", () => {
        expect(subnetBucket("203.0.113.7")).toBe("203.0.113.0/24");
        expect(subnetBucket("203.0.113.250")).toBe(subnetBucket("203.0.113.7"));
        expect(subnetBucket("203.0.114.7")).not.toBe(subnetBucket("203.0.113.7"));
    });

    test("an IPv6 address buckets as its /48, whatever its spelling", () => {
        expect(subnetBucket("2001:db8:1:2::1")).toBe("2001:db8:1::/48");
        expect(subnetBucket("2001:db8:1:ffff::9")).toBe("2001:db8:1::/48");
        expect(subnetBucket("2001:0DB8:0001::")).toBe("2001:db8:1::/48");
        expect(subnetBucket("2001:db8:2::1")).not.toBe(subnetBucket("2001:db8:1::1"));
        expect(subnetBucket("::1")).toBe("0:0:0::/48");
    });

    test("an IPv4-mapped address buckets as its IPv4 /24, not the all-zero /48", () => {
        expect(subnetBucket("::ffff:203.0.113.5")).toBe("::ffff:203.0.113.0/24");
        expect(subnetBucket("::ffff:203.0.113.5")).not.toBe(subnetBucket("::ffff:198.51.100.5"));
    });

    test("a subnet bucket is never the same string as an address bucket", () => {
        for (const address of ["203.0.113.7", "2001:db8:1:2::1", "::ffff:203.0.113.5"]) {
            expect(subnetBucket(address)).not.toBe(ipBucket(address));
        }
    });
});
