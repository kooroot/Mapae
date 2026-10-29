import type {D1Database} from '@cloudflare/workers-types';
import {DAY_MS, PASSIVE_EVENTS, RAW_RETENTION_MS, VISITOR_TTL_MS, seoulDay, type StoredEngagement, type TrafficSource} from './model';

export type EngagementDatabase = Pick<D1Database, 'prepare' | 'batch'>;
export type Visitor = {hash: string; first_at: number; expires_at: number; last_at: number; session: string; session_at: number};
export type DailyActivity = {day: string; browser_visitors: number; browser_dau: number; owner_dau: number; practice_opened: number; practice_completed: number; profile_authenticated: number};
export type CohortRow = {day: string; visitors: number; returned_d1: number; returned_d7: number; authenticated: number};
/** Distinct browsers reaching each stage. mapae.io and faucet.mapae.io keep separate browser IDs, so the faucet stages count a separate population. */
export type FunnelRow = {source: TrafficSource | 'unknown'; landing: number; arcade: number; practiced: number; connected: number; mint_started: number; outing_started: number;
    faucet_opened: number; faucet_musdc: number; faucet_eth: number};
// Deliberate interaction: anything a browser reports except arriving at a page.
const deliberate = (table = '') => `${table}trust='client_reported' AND ${table}event NOT IN (${PASSIVE_EVENTS.map(e => `'${e}'`).join(',')})`;
export function engagementRepository(db: EngagementDatabase) {
    return {
        async limit(bucket: string, expires: number, maximum: number) {
            return !!await db.prepare('INSERT INTO arcade_engagement_limits (bucket,count,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count').bind(bucket, expires, maximum).first();
        },
        visitor(hash: string, now: number) {return db.prepare('SELECT * FROM arcade_engagement_visitors WHERE hash=? AND expires_at>?').bind(hash, now).first<Visitor>();},
        async createVisitor(hash: string, now: number, session: string, source: TrafficSource) {
            await db.batch([
                db.prepare('INSERT INTO arcade_engagement_visitors (hash,first_at,expires_at,last_at,session,session_at) VALUES (?,?,?,?,?,?)').bind(hash, now, now + VISITOR_TTL_MS, now, session, now),
                db.prepare('INSERT INTO arcade_engagement_sources (visitor,source) VALUES (?,?) ON CONFLICT DO NOTHING').bind(hash, source),
            ]);
            return {hash, first_at: now, expires_at: now + VISITOR_TTL_MS, last_at: now, session, session_at: now};
        },
        async touchVisitor(hash: string, now: number, session: string) {
            // Atomic CASE keeps concurrent tabs in one session; background game timers never call this.
            return (await db.prepare(`UPDATE arcade_engagement_visitors SET
                session=CASE WHEN last_at<=? OR session_at<=? THEN ? ELSE session END,
                session_at=CASE WHEN last_at<=? OR session_at<=? THEN ? ELSE session_at END,
                last_at=MAX(last_at,?) WHERE hash=? RETURNING *`)
                .bind(now - 1_800_000, now - DAY_MS, session, now - 1_800_000, now - DAY_MS, now, now, hash).first<Visitor>())!;
        },
        async record(e: StoredEngagement): Promise<'inserted' | 'duplicate' | 'unpaired'> {
            if (e.event === 'practice_finished' && !await db.prepare("SELECT id FROM arcade_engagement_events WHERE visitor=? AND run_id=? AND game=? AND event='practice_opened'").bind(e.visitor, e.runId, e.game).first()) return 'unpaired';
            const row = await db.prepare('INSERT INTO arcade_engagement_events (id,visitor,session,owner,event,game,run_id,result,locale,at,day,trust) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id')
                .bind(e.id, e.visitor, e.session, e.owner, e.event, e.game, e.runId, e.result, e.locale, e.at, e.day, e.trust).first();
            return row ? 'inserted' : 'duplicate';
        },
        async cleanup(now: number) {
            await db.batch([
                db.prepare('DELETE FROM arcade_engagement_events WHERE at < ?').bind(now - RAW_RETENTION_MS),
                db.prepare('DELETE FROM arcade_engagement_visitors WHERE expires_at <= ?').bind(now),
                db.prepare('DELETE FROM arcade_engagement_sources WHERE visitor NOT IN (SELECT hash FROM arcade_engagement_visitors)'),
                db.prepare('DELETE FROM arcade_engagement_limits WHERE expires_at <= ?').bind(now),
                db.prepare('DELETE FROM arcade_engagement_daily WHERE day < ?').bind(seoulDay(now - 400 * DAY_MS)),
            ]);
        },
        async daily(since: string) {
            return (await db.prepare(`SELECT day,
                COUNT(DISTINCT CASE WHEN trust='client_reported' THEN visitor END) AS browser_visitors,
                COUNT(DISTINCT CASE WHEN ${deliberate()} THEN visitor END) AS browser_dau,
                COUNT(DISTINCT CASE WHEN (${deliberate()}) OR (trust='server_authenticated' AND event='profile_authenticated') THEN owner END) AS owner_dau,
                SUM(event='practice_opened') AS practice_opened,
                SUM(event='practice_finished' AND result='completed') AS practice_completed,
                COUNT(DISTINCT CASE WHEN event='profile_authenticated' THEN owner END) AS profile_authenticated
                FROM arcade_engagement_events WHERE day>=? GROUP BY day ORDER BY day`).bind(since).all<DailyActivity>()).results;
        },
        async cohorts(since: string) {
            // A cohort is the browsers whose first day included deliberate interaction; a page arrival alone joins none.
            return (await db.prepare(`WITH cohorts AS (
                SELECT v.hash, date(v.first_at/1000,'unixepoch','+9 hours') AS cohort_day,
                MAX(CASE WHEN e.day=date(v.first_at/1000,'unixepoch','+9 hours') AND ${deliberate('e.')} THEN 1 ELSE 0 END) AS engaged,
                MAX(CASE WHEN e.day=date(v.first_at/1000,'unixepoch','+9 hours','+1 day') AND ${deliberate('e.')} THEN 1 ELSE 0 END) AS d1,
                MAX(CASE WHEN e.day=date(v.first_at/1000,'unixepoch','+9 hours','+7 day') AND ${deliberate('e.')} THEN 1 ELSE 0 END) AS d7,
                MAX(e.event='profile_authenticated') AS authenticated
                FROM arcade_engagement_visitors v JOIN arcade_engagement_events e ON e.visitor=v.hash
                WHERE date(v.first_at/1000,'unixepoch','+9 hours')>=? GROUP BY v.hash
            ) SELECT cohort_day AS day,COUNT(*) AS visitors,SUM(d1) AS returned_d1,SUM(d7) AS returned_d7,SUM(authenticated) AS authenticated
              FROM cohorts WHERE engaged=1 GROUP BY cohort_day ORDER BY cohort_day`).bind(since).all<CohortRow>()).results;
        },
        async funnel(since: string) {
            const stage = (condition: string) => `COUNT(DISTINCT CASE WHEN ${condition} THEN e.visitor END)`;
            return (await db.prepare(`SELECT COALESCE(s.source,'unknown') AS source,
                ${stage("e.event='landing_viewed'")} AS landing, ${stage("e.event='arcade_entered'")} AS arcade,
                ${stage("e.event='practice_finished' AND e.result='completed'")} AS practiced, ${stage("e.event='profile_authenticated'")} AS connected,
                ${stage("e.event='mint_started'")} AS mint_started, ${stage("e.event='outing_started'")} AS outing_started,
                ${stage("e.event='faucet_opened'")} AS faucet_opened, ${stage("e.event='faucet_musdc_claimed'")} AS faucet_musdc, ${stage("e.event='faucet_eth_claimed'")} AS faucet_eth
                FROM arcade_engagement_events e LEFT JOIN arcade_engagement_sources s ON s.visitor=e.visitor
                WHERE e.day>=? GROUP BY 1 ORDER BY 1`).bind(since).all<FunnelRow>()).results;
        },
        async totals(since: string) {
            return (await db.prepare('SELECT day,event,trust,count FROM arcade_engagement_daily WHERE day>=? ORDER BY day,event').bind(since).all<{day: string; event: string; trust: string; count: number}>()).results;
        },
    };
}
export type EngagementRepository = ReturnType<typeof engagementRepository>;
