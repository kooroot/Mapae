import {DAY_MS, ENGAGEMENT_LIMITS, MAX_EVENT_BYTES, VISITOR_TTL_MS, parseEngagement, seoulDay, type ServerEvent, type StoredEngagement} from './model';
import type {EngagementRepository} from './repository';

const COOKIE = '__Host-mapae-arcade-visitor';
// Each origin keeps its own host-only browser ID: a faucet visitor is never joined to an arcade visitor.
const ORIGINS = new Set(['https://mapae.io', 'https://app.mapae.io', 'https://faucet.mapae.io']);
const headers = {'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"};
const json = (body: unknown, status = 202) => Response.json(body, {status, headers});
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
function visitorToken(request: Request): string | null {
    const value = request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
async function readInput(request: Request) {
    const reader = request.body?.getReader(); if (!reader) throw new SyntaxError();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_EVENT_BYTES) {await reader.cancel(); throw new RangeError();} chunks.push(part.value);}
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
}
async function allowGlobal(request: Request, repo: EngagementRepository, now: number) {
    const day = Math.floor(now / DAY_MS), minute = Math.floor(now / 60_000);
    if (!await repo.limit(`global:${day}`, (day + 1) * DAY_MS, ENGAGEMENT_LIMITS.globalDay)) return false;
    // Only the trusted platform header, never X-Forwarded-For. Daily prefix limits linkability;
    // this unsalted hash is an abuse bucket, not anonymous identity or a claim of anonymization.
    const ip = request.headers.get('CF-Connecting-IP');
    return !ip || await repo.limit(`ip:${await hash(`${day}:${ip}`)}:${minute}`, (minute + 1) * 60_000, ENGAGEMENT_LIMITS.ipMinute);
}
async function cleanOccasionally(repo: EngagementRepository, now: number) {
    const minute = Math.floor(now / 60_000);
    if (await repo.limit(`cleanup:${minute}`, (minute + 1) * 60_000, 1)) await repo.cleanup(now);
}
export async function engagementApi(request: Request, repo: EngagementRepository, options: {development?: boolean; now?: number; resolveOwner?: (request: Request) => Promise<string | null>} = {}): Promise<Response> {
    const url = new URL(request.url), now = options.now ?? Date.now();
    const local = options.development && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.pathname !== '/api/arcade/engagement' || url.search) return json({error: 'not_found'}, 404);
    if (request.method !== 'POST') return json({error: 'method_not_allowed'}, 405);
    if ((!ORIGINS.has(url.origin) && !local) || request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site' || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return json({error: 'origin_denied'}, 403);
    try {
        const input = parseEngagement(await readInput(request));
        if (!input) return json({error: 'invalid_event'}, 400);
        if (!await allowGlobal(request, repo, now)) {const r = json({error: 'rate_limited'}, 429); r.headers.set('Retry-After', '60'); return r;}
        await cleanOccasionally(repo, now);
        const token = visitorToken(request);
        let visitor = token ? await repo.visitor(await hash(token), now) : null;
        let created: string | undefined;
        if (!visitor) {
            if (input.event === 'practice_finished') return json({error: 'practice_not_opened'}, 422);
            created = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
            visitor = await repo.createVisitor(await hash(created), now, crypto.randomUUID(), input.source);
        } else visitor = await repo.touchVisitor(visitor.hash, now, crypto.randomUUID());
        const day = Math.floor(now / DAY_MS);
        if (!await repo.limit(`visitor:${visitor.hash}:${day}`, (day + 1) * DAY_MS, ENGAGEMENT_LIMITS.visitorDay)) return json({error: 'rate_limited'}, 429);
        const authenticated = await options.resolveOwner?.(request);
        const owner = authenticated && /^0x[a-f0-9]{40}$/i.test(authenticated) ? authenticated.toLowerCase() : null;
        const result = await repo.record({id: input.id, visitor: visitor.hash, session: visitor.session, owner, event: input.event, game: input.game ?? null,
            runId: 'runId' in input ? input.runId : null, result: 'result' in input ? input.result : null, locale: input.locale, at: now, day: seoulDay(now), trust: 'client_reported'});
        const response = result === 'unpaired' ? json({error: 'practice_not_opened'}, 422) : json({accepted: true});
        if (created) response.headers.set('Set-Cookie', `${COOKIE}=${created}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${VISITOR_TTL_MS / 1000}`);
        return response;
    } catch (e) {
        return json({error: e instanceof RangeError ? 'body_too_large' : e instanceof SyntaxError ? 'invalid_json' : 'engagement_unavailable'}, e instanceof RangeError ? 413 : e instanceof SyntaxError ? 400 : 503);
    }
}
/**
 * Call only once the server has verified the wallet: a SIWE login, or a faucet claim under
 * a SIWE session. A browser that never reported anything has no ID here and records nothing.
 * Failure must not block what it measures.
 */
export async function recordAuthenticatedEngagement(request: Request, repo: EngagementRepository, owner: string, event: ServerEvent, now = Date.now()): Promise<void> {
    if (!/^0x[a-f0-9]{40}$/i.test(owner)) return;
    const token = visitorToken(request); if (!token) return;
    const visitor = await repo.visitor(await hash(token), now); if (!visitor) return;
    if (!await allowGlobal(request, repo, now)) return;
    // SIWE has no language field. Do not infer English from the shared /api path.
    const e: StoredEngagement = {id: crypto.randomUUID(), visitor: visitor.hash, session: visitor.session, owner: owner.toLowerCase(), event, game: null, runId: null, result: null, locale: 'und', at: now, day: seoulDay(now), trust: 'server_authenticated'};
    await repo.record(e);
}
