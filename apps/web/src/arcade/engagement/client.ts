import {PASSIVE_EVENTS, trafficSource, type ClientEvent, type EngagementInput, type TrafficSource} from './model';

/** First-party, bounded, in-memory telemetry. It never blocks play or persists credentials. */
export function createEngagementClient(send: typeof fetch = fetch, source: TrafficSource = 'direct') {
    const queue: EngagementInput[] = [];
    const arrived = new Set<string>();
    let busy = false;
    async function flush() {
        if (busy) return;
        busy = true;
        try {
            while (queue.length) {
                const event = queue.shift()!;
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const response = await send('/api/arcade/engagement', {method: 'POST', headers: {'Content-Type': 'application/json'}, credentials: 'same-origin', body: JSON.stringify(event), keepalive: true, signal: AbortSignal.timeout(5000)});
                        if (response.status === 429) {queue.length = 0; return;}
                        if (response.status < 500) break;
                    } catch { /* Telemetry failures do not affect the game. Retry once with the same id. */ }
                }
            }
        } finally {busy = false;}
    }
    return (event: ClientEvent & {locale: 'ko' | 'en'}) => {
        // One arrival per page load, however often a view mounts.
        if ((PASSIVE_EVENTS as readonly string[]).includes(event.event)) {if (arrived.has(event.event)) return; arrived.add(event.event);}
        if (queue.length >= 10) return;
        queue.push({...event, version: 1, id: crypto.randomUUID(), source});
        void flush();
    };
}
let client: ReturnType<typeof createEngagementClient> | undefined;
export function trackEngagement(event: ClientEvent & {locale: 'ko' | 'en'}) {
    if (typeof window === 'undefined') return;
    // Read once, from the address the page loaded with: the source travels with every event, and the server keeps the first.
    client ??= createEngagementClient(fetch, trafficSource(window.location.search, document.referrer));
    client(event);
}
