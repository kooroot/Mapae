/**
 * Client network buckets for rate limits.
 *
 * Shared rather than living with the bootstrap service because a Cloudflare Worker keys
 * its limits the same way, and the Worker must not bundle the smart-accounts kit to get a
 * string function. Neither function validates: a value that is not an address yields a
 * stable garbage bucket, which is all a header we did not set deserves.
 */

/**
 * The network a client address is rate-limited as.
 *
 * IPv4 is the address itself. IPv6 is its /64: Cloudflare forwards the client's full
 * 128-bit address, and a residential IPv6 client is delegated at least a /64 (RFC 6177)
 * it can bind at will, so keyed per address one machine sourcing each request from a
 * fresh address would present a fresh key every time — counted 1, never refused, and
 * the map growing by one entry per request until the sweep. The /64 is the finest
 * bucket that still names one site rather than one of its 2^64 addresses. Groups are
 * normalised (case, leading zeros, `::`) so the bucket does not depend on spelling.
 *
 * An IPv4 address in its IPv6-mapped spelling (`::ffff:a.b.c.d`) is one client too and
 * is kept whole: its "/64" would be the same four zero groups for every IPv4 client
 * there is, and folding it would put all of them in one window.
 */
export function ipBucket(address: string): string {
    if (!address.includes(":") || address.includes(".")) return address;
    return `${v6Prefix(address, 4)}::/64`;
}

/**
 * The wider network around a client: the IPv4 /24, or the IPv6 /48.
 *
 * A farm renting addresses usually rents them in a block — one VPS provider's /24, one
 * site's /48 — so a per-subnet count catches the rotation a per-address count cannot,
 * while staying wide enough that its cap can be generous for a shared office or campus.
 * An IPv4-mapped address buckets as its IPv4 /24 under the mapped prefix, for the same
 * reason {@link ipBucket} keeps it whole.
 */
export function subnetBucket(address: string): string {
    if (!address.includes(":")) return `${v4Prefix(address)}.0/24`;
    if (address.includes(".")) {
        const v4 = address.slice(address.lastIndexOf(":") + 1);
        return `::ffff:${v4Prefix(v4)}.0/24`;
    }
    return `${v6Prefix(address, 3)}::/48`;
}

function v4Prefix(address: string): string {
    return address.split(".").slice(0, 3).join(".");
}

function v6Prefix(address: string, groupCount: number): string {
    const [head = "", tail] = address.split("::", 2);
    const headGroups = head === "" ? [] : head.split(":");
    const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
    const elided = tail === undefined ? 0 : Math.max(8 - headGroups.length - tailGroups.length, 0);
    const groups = [...headGroups, ...new Array<string>(elided).fill("0"), ...tailGroups];
    return groups.slice(0, groupCount).map((group) => Number.parseInt(group, 16).toString(16)).join(":");
}
