import {DAY_MS, seoulDay} from './model';
import type {EngagementRepository} from './repository';

/** Private operator report. Do not expose this through the anonymous ingestion endpoint. */
export async function engagementReport(repo: EngagementRepository, now = Date.now()) {
    const today = seoulDay(now), since = seoulDay(now - 28 * DAY_MS);
    const [daily, cohorts, totals] = await Promise.all([repo.daily(since), repo.cohorts(since), repo.totals(seoulDay(now - 399 * DAY_MS))]);
    function maturity(day: string, offset: number) {return seoulDay(Date.parse(day + 'T00:00:00+09:00') + offset * DAY_MS) < today;}
    return {generatedAt: new Date(now).toISOString(), timezone: 'Asia/Seoul', observationWindow: {since, through: today, todayPartial: true},
        definitions: {browserDau: 'Distinct first-party browser visitors reporting deliberate interaction; not verified people.', ownerDau: 'Distinct session-authenticated wallets reporting deliberate human interaction or completing foreground SIWE login; excludes background agents and polls.', retention: 'Exact cohort-relative calendar day. A target day is mature only after that full Asia/Seoul day ends.', authority: 'Client-reported practice never awards NFT growth. Payments, agent executions and chain transaction counts come from their authoritative ledgers.'},
        daily, cohorts: cohorts.map(row => ({day: row.day, visitors: row.visitors, authenticated: row.authenticated,
            d1: {mature: maturity(row.day, 1), returned: maturity(row.day, 1) ? row.returned_d1 : null, rate: maturity(row.day, 1) ? row.returned_d1 / row.visitors : null},
            d7: {mature: maturity(row.day, 7), returned: maturity(row.day, 7) ? row.returned_d7 : null, rate: maturity(row.day, 7) ? row.returned_d7 / row.visitors : null}})), totals};
}
