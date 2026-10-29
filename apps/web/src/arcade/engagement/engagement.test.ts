import {Database} from 'bun:sqlite';
import {describe, expect, test} from 'bun:test';
import type {D1Database} from '@cloudflare/workers-types';
import {readFileSync} from 'node:fs';
import {engagementApi, recordAuthenticatedEngagement} from './api';
import {createEngagementClient} from './client';
import {engagementRepository} from './repository';
import {engagementReport} from './report';
import {DAY_MS, ENGAGEMENT_LIMITS, MAX_EVENT_BYTES, parseEngagement, seoulDay, trafficSource} from './model';
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
const input = (extra: object = {}) => ({version: 1, id: crypto.randomUUID(), event: 'guardian_cta', locale: 'ko', source: 'direct', ...extra});
function request(value: unknown, cookie?: string, extra?: HeadersInit, origin = 'https://mapae.io') {
    return new Request(`${origin}/api/arcade/engagement`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...extra}, body: JSON.stringify(value)});
}
const cookieOf = (r: Response) => r.headers.get('Set-Cookie')!.split(';')[0]!;
const count = (db: Database, table = 'arcade_engagement_events') => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;

describe('bounded first-party engagement', () => {
    test('schema rejects forged authority, scores, timestamps, unknown fields and invalid terminal shapes', () => {
        for (const extra of [{owner}, {score: 999}, {at: NOW}, {tokenId: 1}, {event: 'profile_authenticated'}, {event: 'practice_finished', game: 'race'}, {event: 'practice_opened', game: 'race', runId: crypto.randomUUID(), result: 'completed'}, {event: 'arcade_entered', result: 'completed'}, {event: {toString: null}}, {locale: {toString: null}}, {game: {toString: null}},
            {source: undefined}, {source: 'facebook'}, {source: {toString: null}}, {event: 'mint_started', game: 'race'}, {event: 'landing_viewed', runId: crypto.randomUUID()}, {event: 'faucet_eth_claimed'}]) expect(parseEngagement(input(extra))).toBeNull();
        for (const event of ['landing_viewed', 'faucet_opened', 'arcade_entered', 'mint_started', 'outing_started']) expect(parseEngagement(input({event, source: 'x'}))).not.toBeNull();
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
        await recordAuthenticatedEngagement(request({}, cookie), repo, owner, 'profile_authenticated', NOW);
        await recordAuthenticatedEngagement(request({}, cookie), repo, owner, 'profile_authenticated', NOW);
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
        await recordAuthenticatedEngagement(request({}, cookie), repo, owner, 'profile_authenticated', before);
        await recordAuthenticatedEngagement(request({}, cookie), repo, '0x' + '34'.repeat(20), 'profile_authenticated', before);
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
    test('first touch decides the source: an explicit ref, then the referring site, else direct', () => {
        expect(trafficSource('?ref=X', 'https://t.co/abc')).toBe('x');
        expect(trafficSource('?ref=share', '')).toBe('share');
        for (const ref of ['?ref=', '?ref=facebook']) expect(trafficSource(ref, '')).toBe('other');
        expect(trafficSource('', 'https://t.co/')).toBe('x'); expect(trafficSource('', 'https://mobile.twitter.com/')).toBe('x');
        expect(trafficSource('', 'https://t.me/')).toBe('telegram'); expect(trafficSource('', 'https://discord.com/channels/1')).toBe('discord');
        expect(trafficSource('', 'https://open.kakao.com/')).toBe('kakao'); expect(trafficSource('', 'https://www.giwa.io/')).toBe('giwa');
        expect(trafficSource('', 'https://mapae.io/')).toBe('internal'); expect(trafficSource('', 'https://notmapae.io/')).toBe('other');
        expect(trafficSource('', 'https://www.google.com/')).toBe('other'); expect(trafficSource('', '')).toBe('direct');
    });
    test('the source is written once with the browser, later hints never move it, and it outlives the visitor until its last event', async () => {
        const {db, repo} = fixture();
        const r = await engagementApi(request(input({event: 'landing_viewed', source: 'x'})), repo, {now: NOW}); const cookie = cookieOf(r);
        await engagementApi(request(input({source: 'discord'}), cookie), repo, {now: NOW});
        expect(db.query('SELECT source FROM arcade_engagement_sources').all()).toEqual([{source: 'x'}]);
        const late = NOW + 85 * DAY_MS;
        expect((await engagementApi(request(input({event: 'mint_started'}), cookie), repo, {now: late, resolveOwner: async () => owner})).status).toBe(202);
        await repo.cleanup(NOW + 91 * DAY_MS);
        expect(count(db, 'arcade_engagement_visitors')).toBe(0);
        expect((await repo.funnel(seoulDay(late))).map(row => row.source)).toEqual(['x']);
        await repo.cleanup(late + 36 * DAY_MS);
        expect(count(db, 'arcade_engagement_sources')).toBe(0);
    });
    test('a browser joins the cohort of its first day of play, not the day it first arrived', async () => {
        const {repo} = fixture();
        const cookie = cookieOf(await engagementApi(request(input({event: 'landing_viewed'})), repo, {now: NOW - 3 * DAY_MS}));
        for (const day of [2, 1]) await engagementApi(request(input(), cookie), repo, {now: NOW - day * DAY_MS});
        const {cohorts} = await engagementReport(repo, NOW);
        expect(cohorts).toHaveLength(1);
        expect(cohorts[0]).toMatchObject({day: seoulDay(NOW - 2 * DAY_MS), visitors: 1, d1: {mature: true, returned: 1, rate: 1}});
    });
    test('page arrivals are funnel stages only: deduplicated per session, outside DAU and cohorts', async () => {
        const {repo} = fixture();
        const r = await engagementApi(request(input({event: 'landing_viewed', source: 'x'})), repo, {now: NOW}); const cookie = cookieOf(r);
        for (const event of ['landing_viewed', 'arcade_entered', 'arcade_entered']) await engagementApi(request(input({event}), cookie), repo, {now: NOW});
        let report = await engagementReport(repo, NOW);
        expect(report.daily[0]).toMatchObject({browser_visitors: 1, browser_dau: 0, owner_dau: 0});
        expect(report.cohorts).toEqual([]);
        expect(report.funnel.total).toMatchObject({landing: 1, arcade: 1, practiced: 0});
        await engagementApi(request(input(), cookie), repo, {now: NOW, resolveOwner: async () => owner});
        report = await engagementReport(repo, NOW);
        expect(report.daily[0]).toMatchObject({browser_visitors: 1, browser_dau: 1, owner_dau: 1}); expect(report.cohorts[0]?.visitors).toBe(1);
        expect((await engagementReport(repo, NOW)).totals.find(t => t.event === 'landing_viewed')?.count).toBe(1);
    });
    test('the funnel counts browsers per stage by first-touch source; the faucet origin is a separate population', async () => {
        const {repo} = fixture(); const runId = crypto.randomUUID();
        const site = cookieOf(await engagementApi(request(input({event: 'landing_viewed', source: 'x'})), repo, {now: NOW}));
        await engagementApi(request(input({event: 'practice_opened', game: 'race', runId}), site), repo, {now: NOW});
        await engagementApi(request(input({event: 'practice_finished', game: 'race', runId, result: 'completed'}), site), repo, {now: NOW});
        await recordAuthenticatedEngagement(request({}, site), repo, owner, 'profile_authenticated', NOW);
        await engagementApi(request(input({event: 'mint_started'}), site), repo, {now: NOW, resolveOwner: async () => owner});
        await engagementApi(request(input({event: 'arcade_entered', source: 'direct'})), repo, {now: NOW});
        const faucet = 'https://faucet.mapae.io';
        const opened = await engagementApi(request(input({event: 'faucet_opened', source: 'arcade'}), undefined, undefined, faucet), repo, {now: NOW});
        expect(opened.status).toBe(202);
        await recordAuthenticatedEngagement(request({}, cookieOf(opened), undefined, faucet), repo, owner, 'faucet_eth_claimed', NOW);
        await recordAuthenticatedEngagement(request({}, undefined, undefined, faucet), repo, owner, 'faucet_musdc_claimed', NOW);
        const {funnel} = await engagementReport(repo, NOW);
        expect(funnel.bySource.map(row => row.source)).toEqual(['arcade', 'direct', 'x']);
        expect(funnel.bySource.find(row => row.source === 'x')).toMatchObject({landing: 1, arcade: 0, practiced: 1, connected: 1, mint_started: 1, faucet_opened: 0});
        expect(funnel.bySource.find(row => row.source === 'arcade')).toMatchObject({faucet_opened: 1, faucet_eth: 1, faucet_musdc: 0});
        expect(funnel.total).toMatchObject({landing: 1, arcade: 1, practiced: 1, connected: 1, mint_started: 1, outing_started: 0, faucet_opened: 1, faucet_eth: 1});
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
    test('client sends each page arrival once and stamps every event with the page source', async () => {
        const bodies: Record<string, unknown>[] = [];
        const client = createEngagementClient((async (_url: unknown, options: RequestInit) => {bodies.push(JSON.parse(String(options.body))); return new Response(null, {status: 202});}) as typeof fetch, 'telegram');
        for (const event of ['landing_viewed', 'landing_viewed', 'arcade_entered', 'arcade_entered', 'guardian_cta', 'guardian_cta'] as const) client({event, locale: 'ko'});
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(bodies.map(body => body.event)).toEqual(['landing_viewed', 'arcade_entered', 'guardian_cta', 'guardian_cta']);
        expect(new Set(bodies.map(body => body.source))).toEqual(new Set(['telegram']));
    });
});
