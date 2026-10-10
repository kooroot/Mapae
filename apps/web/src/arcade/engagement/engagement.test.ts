import {Database} from 'bun:sqlite';
import {describe, expect, test} from 'bun:test';
import type {D1Database} from '@cloudflare/workers-types';
import {readFileSync} from 'node:fs';
import {engagementApi, recordAuthenticatedEngagement} from './api';
import {createEngagementClient} from './client';
import {engagementRepository} from './repository';
import {engagementReport} from './report';
import {DAY_MS, ENGAGEMENT_LIMITS, MAX_EVENT_BYTES, parseEngagement} from './model';
const NOW = Date.parse('2026-10-10T12:00:00+09:00');
const owner = '0x' + '12'.repeat(20);
function fixture() {
    const db = new Database(':memory:'); db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    function prepare(sql: string, args: unknown[] = []): unknown {
        const values = args as (string | number | null)[];
        return {bind: (...next: unknown[]) => prepare(sql, next), first: async () => db.query(sql).get(...values), run: async () => db.query(sql).run(...values), all: async () => ({results: db.query(sql).all(...values)})};
    }
    const d1 = {prepare, batch: async (items: {run: () => Promise<unknown>}[]) => {const result: unknown[] = []; db.exec('BEGIN'); try {for (const item of items) result.push(await item.run()); db.exec('COMMIT'); return result;} catch (e) {db.exec('ROLLBACK'); throw e;}}} as unknown as Pick<D1Database, 'prepare' | 'batch'>;
    return {db, repo: engagementRepository(d1)};
}
const input = (extra: object = {}) => ({version: 1, id: crypto.randomUUID(), event: 'arcade_entered', locale: 'ko', ...extra});
function request(value: unknown, cookie?: string, extra?: HeadersInit) {
    return new Request('https://mapae.io/api/arcade/engagement', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://mapae.io', ...(cookie ? {Cookie: cookie} : {}), ...extra}, body: JSON.stringify(value)});
}
const cookieOf = (r: Response) => r.headers.get('Set-Cookie')!.split(';')[0]!;
const count = (db: Database, table = 'arcade_engagement_events') => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;

describe('bounded first-party engagement', () => {
    test('schema rejects forged authority, scores, timestamps, unknown fields and invalid terminal shapes', () => {
        for (const extra of [{owner}, {score: 999}, {at: NOW}, {tokenId: 1}, {event: 'profile_authenticated'}, {event: 'practice_finished', game: 'race'}, {event: 'practice_opened', game: 'race', runId: crypto.randomUUID(), result: 'completed'}, {event: 'arcade_entered', result: 'completed'}, {event: {toString: null}}, {locale: {toString: null}}, {game: {toString: null}}]) expect(parseEngagement(input(extra))).toBeNull();
        expect(parseEngagement(input({event: 'practice_finished', game: 'stamp', runId: crypto.randomUUID(), result: 'ended_early'}))).not.toBeNull();
    });
    test('first-party cookie, unknown cookies replaced, identity is never a submitted wallet', async () => {
        const {db, repo} = fixture();
        const r = await engagementApi(request(input(), '__Host-mapae-arcade-visitor=' + 'a'.repeat(64)), repo, {now: NOW});
        expect(r.status).toBe(202); expect(r.headers.get('Set-Cookie')).toContain('HttpOnly; Secure; SameSite=Strict');
        const event = db.query('SELECT * FROM arcade_engagement_events').get() as {owner: unknown; at: number; visitor: string};
        expect(event.owner).toBeNull(); expect(event.at).toBe(NOW); expect(event.visitor).not.toContain('a'.repeat(64));
        expect(count(db, 'arcade_engagement_visitors')).toBe(1);
    });
    test('rejects foreign origins, unsupported methods, queries and oversized chunked payloads before storage', async () => {
        const {db, repo} = fixture();
        expect((await engagementApi(request(input(), undefined, {Origin: 'https://evil.example'}), repo)).status).toBe(403);
        expect((await engagementApi(request(input(), undefined, {'Sec-Fetch-Site': 'cross-site'}), repo)).status).toBe(403);
        expect((await engagementApi(new Request('https://mapae.io/api/arcade/engagement'), repo)).status).toBe(405);
        const stream = new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode(' '.repeat(MAX_EVENT_BYTES))); c.enqueue(new Uint8Array([32])); c.close();}});
        expect((await engagementApi(new Request('https://mapae.io/api/arcade/engagement', {method: 'POST', headers: {Origin: 'https://mapae.io', 'Content-Type': 'application/json'}, body: stream}), repo)).status).toBe(413);
        expect(count(db)).toBe(0); expect(count(db, 'arcade_engagement_visitors')).toBe(0);
    });
    test('deduplicates event IDs and run terminal states; only opened same-game runs can finish', async () => {
        const {db, repo} = fixture(); const runId = crypto.randomUUID();
        const first = await engagementApi(request(input()), repo, {now: NOW}); const cookie = cookieOf(first);
        expect((await engagementApi(request(input({event: 'practice_finished', game: 'race', runId, result: 'completed'}), cookie), repo, {now: NOW})).status).toBe(422);
        const opened = input({event: 'practice_opened', game: 'race', runId});
        for (let i = 0; i < 2; i++) expect((await engagementApi(request(opened, cookie), repo, {now: NOW})).status).toBe(202);
        expect((await engagementApi(request(input({event: 'practice_finished', game: 'shop', runId, result: 'completed'}), cookie), repo, {now: NOW})).status).toBe(422);
        for (const result of ['ended_early', 'completed']) await engagementApi(request(input({event: 'practice_finished', game: 'race', runId, result}), cookie), repo, {now: NOW});
        expect(count(db)).toBe(3);
        expect((await engagementReport(repo, NOW)).daily[0]?.practice_completed).toBe(0);
        expect((db.query('SELECT SUM(count) AS n FROM arcade_engagement_daily').get() as {n: number}).n).toBe(3);
    });
    test('parallel SQL limits, cookie rotation and trusted IP limits bound ingestion', async () => {
        const {db, repo} = fixture();
        const accepted = await Promise.all(Array.from({length: 30}, () => repo.limit('race', NOW + 1000, 7)));
        expect(accepted.filter(Boolean)).toHaveLength(7);
        const day = Math.floor(NOW / DAY_MS);
        db.exec(`INSERT INTO arcade_engagement_limits VALUES ('global:${day}',${ENGAGEMENT_LIMITS.globalDay},${NOW + DAY_MS})`);
        const r = await engagementApi(request(input()), repo, {now: NOW});
        expect(r.status).toBe(429); expect(count(db, 'arcade_engagement_visitors')).toBe(0);
        db.exec('DELETE FROM arcade_engagement_limits');
        const first = await engagementApi(request(input()), repo, {now: NOW}); const cookie = cookieOf(first);
        const visitor = (db.query('SELECT hash FROM arcade_engagement_visitors').get() as {hash: string}).hash;
        db.query('UPDATE arcade_engagement_limits SET count=? WHERE bucket=?').run(ENGAGEMENT_LIMITS.visitorDay, `visitor:${visitor}:${day}`);
        expect((await engagementApi(request(input({event: 'guardian_cta'}), cookie), repo, {now: NOW})).status).toBe(429);
    });
    test('SIWE conversion and operator intent count authenticated owners; anonymous requests cannot choose an owner', async () => {
        const {repo} = fixture(); const r = await engagementApi(request(input()), repo, {now: NOW}); const cookie = cookieOf(r);
        await recordAuthenticatedEngagement(request({}, cookie), repo, owner, NOW);
        await recordAuthenticatedEngagement(request({}, cookie), repo, owner, NOW);
        let report = await engagementReport(repo, NOW);
        expect(report.daily[0]?.owner_dau).toBe(1); expect(report.daily[0]?.profile_authenticated).toBe(1);
        await engagementApi(request(input({event: 'guardian_cta'}), cookie), repo, {now: NOW, resolveOwner: async () => owner});
        report = await engagementReport(repo, NOW);
        expect(report.daily[0]?.owner_dau).toBe(1); expect(report.cohorts[0]?.authenticated).toBe(1);
        await engagementApi(request(input({event: 'operator_action'}), cookie), repo, {now: NOW});
        expect((await engagementReport(repo, NOW)).daily[0]?.owner_dau).toBe(1);
        expect((await engagementApi(request(input({event: 'operator_action', game: 'race'}), cookie), repo, {now: NOW})).status).toBe(400);
        await engagementApi(request(input({event: 'operator_action'}), cookie), repo, {now: NOW, resolveOwner: async () => '0x' + '34'.repeat(20)});
        expect((await engagementReport(repo, NOW)).daily[0]?.owner_dau).toBe(2);
    });
    test('D1/D7 report distinguishes exact-day return, mature zeros and immature nulls', async () => {
        const {repo} = fixture(); const cohort = NOW - 8 * DAY_MS;
        const r = await engagementApi(request(input()), repo, {now: cohort}); const cookie = cookieOf(r);
        await engagementApi(request(input()), repo, {now: cohort + DAY_MS});
        await engagementApi(request(input({event: 'guardian_cta'}), cookie), repo, {now: cohort + 7 * DAY_MS});
        const report = await engagementReport(repo, NOW);
        expect(report.cohorts[0]?.d1).toEqual({mature: true, returned: 0, rate: 0});
        expect(report.cohorts[0]?.d7).toEqual({mature: true, returned: 1, rate: 1});
        expect(report.cohorts[1]?.d7).toEqual({mature: false, returned: null, rate: null});
        expect(report.timezone).toBe('Asia/Seoul');
    });
    test('retains distinct wallet logins, observes midnight return and rotates inactive sessions', async () => {
        const {db, repo} = fixture(); const before = Date.parse('2026-10-01T23:59:00+09:00');
        const first = await engagementApi(request(input()), repo, {now: before}); const cookie = cookieOf(first);
        await recordAuthenticatedEngagement(request({}, cookie), repo, owner, before);
        await recordAuthenticatedEngagement(request({}, cookie), repo, '0x' + '34'.repeat(20), before);
        await engagementApi(request(input(), cookie), repo, {now: before + 120_000});
        const report = await engagementReport(repo, Date.parse('2026-10-03T00:00:01+09:00'));
        expect(report.cohorts[0]?.d1).toEqual({mature: true, returned: 1, rate: 1});
        expect(report.daily[0]?.profile_authenticated).toBe(2);
        const prior = (db.query('SELECT session FROM arcade_engagement_visitors').get() as {session: string}).session;
        await engagementApi(request(input({event: 'guardian_cta'}), cookie), repo, {now: before + 3_600_000});
        expect((db.query('SELECT session FROM arcade_engagement_visitors').get() as {session: string}).session).not.toBe(prior);
    });
    test('trusted platform IP quota rejects rotating cookies and no-cookie terminal cannot create visitors', async () => {
        const {db, repo} = fixture();
        expect((await engagementApi(request(input({event: 'practice_finished', game: 'stamp', runId: crypto.randomUUID(), result: 'completed'})), repo, {now: NOW})).status).toBe(422);
        expect(count(db, 'arcade_engagement_visitors')).toBe(0);
        await engagementApi(request(input(), undefined, {'CF-Connecting-IP': '192.0.2.5'}), repo, {now: NOW});
        db.query("UPDATE arcade_engagement_limits SET count=? WHERE bucket LIKE 'ip:%'").run(ENGAGEMENT_LIMITS.ipMinute);
        expect((await engagementApi(request(input(), undefined, {'CF-Connecting-IP': '192.0.2.5'}), repo, {now: NOW})).status).toBe(429);
        expect(count(db, 'arcade_engagement_visitors')).toBe(1);
        expect(JSON.stringify(db.query('SELECT * FROM arcade_engagement_limits').all())).not.toContain('192.0.2.5');
    });
    test('cleanup expires raw events/limits/visitors and preserves only bounded daily totals', async () => {
        const {db, repo} = fixture(); await engagementApi(request(input()), repo, {now: NOW - 91 * DAY_MS});
        await repo.cleanup(NOW);
        expect(count(db)).toBe(0); expect(count(db, 'arcade_engagement_visitors')).toBe(0); expect(count(db, 'arcade_engagement_limits')).toBe(0);
        expect(count(db, 'arcade_engagement_daily')).toBe(1);
        await repo.cleanup(NOW + 401 * DAY_MS); expect(count(db, 'arcade_engagement_daily')).toBe(0);
    });
    test('client sends sequentially, retries same IDs once and caps the in-memory queue', async () => {
        const calls: string[] = []; let release!: () => void;
        const blocked = new Promise<void>(resolve => {release = resolve;});
        const client = createEngagementClient((async (_url: unknown, options: RequestInit) => {calls.push(String(options.body)); await blocked; return new Response(null, {status: 503});}) as typeof fetch);
        for (let i = 0; i < 30; i++) client({event: 'guardian_cta', locale: 'ko'});
        expect(calls).toHaveLength(1); release();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(calls).toHaveLength(22);
        for (let i = 0; i < calls.length; i += 2) expect(calls[i]).toBe(calls[i + 1]);
    });
});
