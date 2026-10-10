import type {ClientEvent, EngagementInput} from './model';

/** First-party, bounded, in-memory telemetry. It never blocks play or persists credentials. */
export function createEngagementClient(send: typeof fetch = fetch) {
    const queue: EngagementInput[] = [];
    let busy = false, entered = false;
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
        if (event.event === 'arcade_entered') {if (entered) return; entered = true;}
        if (queue.length >= 10) return;
        queue.push({...event, version: 1, id: crypto.randomUUID()});
        void flush();
    };
}
let client: ReturnType<typeof createEngagementClient> | undefined;
export function trackEngagement(event: ClientEvent & {locale: 'ko' | 'en'}) {
    if (typeof window === 'undefined') return;
    client ??= createEngagementClient();
    client(event);
}
