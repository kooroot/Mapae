/**
 * Hold the fork source's credential so `anvil` never sees it.
 *
 * `anvil --fork-url <URL>` is the one place this repo was forced to put a secret on a
 * command line. argv is world-readable through `ps`, and the private GIWA endpoint
 * authenticates with an **API key in the URL path** — so for the lifetime of every forked
 * run, any local user could read the credential out of the process table. It was measured
 * and accepted rather than fixed: `--fork-url` has no `[env: …]` alias in this anvil, and
 * `ETH_RPC_URL=<giwa> anvil` with no flag returns chain id `0x7a69` — it does not fork.
 *
 * The escape hatch `CLAUDE.md` named is this file: a loopback proxy that keeps the key in
 * its own memory and hands anvil a keyless `http://127.0.0.1:<port>`.
 *
 * What changed the calculus was the since-retired wallet fork lab: the suites fork for
 * seconds, but the lab was *designed* to sit for as long as a person needed to drive a
 * wallet, which turned a ~15-second window into an open-ended one. The lab is gone (its
 * job was done by the first live sponsored revocation), but the proxy stays: every fork
 * spawn site — `negative-path-suite.ts`, `mcp-e2e.ts`, `bootstrap-e2e.ts`,
 * `revocation-submitter-e2e.ts` — goes through it, and reverting them to a keyed
 * `--fork-url` would reopen a hole documented as closed.
 *
 * Deliberately not a general proxy. It binds loopback, forwards `POST` only, and sends a
 * fixed `content-type` — a JSON-RPC pipe for one child process, not something to grow.
 */
import {redactUrls} from "@mapae/shared";

export interface ForkSourceProxy {
    /** Keyless loopback URL to hand to `anvil --fork-url`. Safe in argv. */
    url: string;
    /** How many upstream calls were forwarded. Useful when a run looks stalled. */
    forwarded(): number;
    stop(): void;
}

export function startForkSourceProxy(upstream: string): ForkSourceProxy {
    let forwarded = 0;

    const server = Bun.serve({
        hostname: "127.0.0.1",
        // Port 0 lets the OS pick a free one, so two forked runs can never collide on a
        // hardcoded proxy port the way they would on a hardcoded anvil port.
        port: 0,
        // A fork replays a lot of history on first touch; the default 10 s hangs up on
        // upstream calls that are merely slow, and anvil reports that as a fork failure.
        idleTimeout: 120,
        async fetch(request) {
            if (request.method !== "POST") {
                return new Response("only POST is proxied", {status: 405});
            }
            forwarded += 1;
            try {
                const response = await fetch(upstream, {
                    method: "POST",
                    headers: {"content-type": "application/json"},
                    body: await request.arrayBuffer(),
                    signal: AbortSignal.timeout(60_000),
                });
                return new Response(response.body, {
                    status: response.status,
                    headers: {"content-type": "application/json"},
                });
            } catch (error) {
                // `redactUrls`, not the raw message: a fetch failure names the endpoint it
                // could not reach, and that endpoint is the credential this file exists to
                // hide. anvil prints whatever it gets back when a fork read fails.
                return new Response(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: null,
                        error: {code: -32603, message: `fork source unreachable: ${redactUrls(String(error))}`},
                    }),
                    {status: 502, headers: {"content-type": "application/json"}},
                );
            }
        },
    });

    return {
        url: `http://127.0.0.1:${server.port}`,
        forwarded: () => forwarded,
        stop: () => server.stop(true),
    };
}
