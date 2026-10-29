import {DAY_MS, seoulDay} from './model';
import type {EngagementRepository, FunnelRow} from './repository';

const STAGES = ['landing', 'arcade', 'practiced', 'connected', 'mint_started', 'outing_started', 'faucet_opened', 'faucet_musdc', 'faucet_eth'] as const;

/** Private operator report. Do not expose this through the anonymous ingestion endpoint. */
export async function engagementReport(repo: EngagementRepository, now = Date.now()) {
    const today = seoulDay(now), since = seoulDay(now - 28 * DAY_MS);
    const [daily, cohorts, bySource, totals] = await Promise.all([repo.daily(since), repo.cohorts(since), repo.funnel(since), repo.totals(seoulDay(now - 399 * DAY_MS))]);
    // Every browser has one source, so the sources partition each stage and their sum is the whole.
    const total = Object.fromEntries(STAGES.map(stage => [stage, bySource.reduce((n, row) => n + row[stage], 0)])) as Omit<FunnelRow, 'source'>;
    function maturity(day: string, offset: number) {return seoulDay(Date.parse(day + 'T00:00:00+09:00') + offset * DAY_MS) < today;}
    return {generatedAt: new Date(now).toISOString(), timezone: 'Asia/Seoul', observationWindow: {since, through: today, todayPartial: true},
        definitions: {browserVisitors: 'Distinct first-party browsers reporting anything, a page arrival included.', browserDau: 'Distinct first-party browser visitors reporting deliberate interaction (not a page arrival); not verified people.', ownerDau: 'Distinct session-authenticated wallets reporting deliberate human interaction or completing foreground SIWE login; excludes background agents and polls.', retention: 'Browsers whose first observed day included deliberate interaction, returning with deliberate interaction on the exact cohort-relative calendar day. A target day is mature only after that full Asia/Seoul day ends.',
            funnel: 'Distinct browsers reaching each stage in the window, by first-touch source: an explicit ?ref=, else the referring site (internal = another mapae.io page, other = anything unrecognised, direct = no hint). Browsers first seen before sources were recorded are unknown. mapae.io and faucet.mapae.io keep separate browser IDs, so faucet stages count a separate population. Stages are not nested: a browser can reach a later stage without an earlier one. mint_started and outing_started are clicks, not confirmed transactions. faucet_musdc and faucet_eth are claims the faucet service accepted (pending, confirmed or already enough; never failed), counted only for a browser that reported an arrival first.', authority: 'Client-reported practice never awards NFT growth. Payments, agent executions and chain transaction counts come from their authoritative ledgers.'},
        daily, cohorts: cohorts.map(row => ({day: row.day, visitors: row.visitors, authenticated: row.authenticated,
            d1: {mature: maturity(row.day, 1), returned: maturity(row.day, 1) ? row.returned_d1 : null, rate: maturity(row.day, 1) ? row.returned_d1 / row.visitors : null},
            d7: {mature: maturity(row.day, 7), returned: maturity(row.day, 7) ? row.returned_d7 : null, rate: maturity(row.day, 7) ? row.returned_d7 / row.visitors : null}})),
        funnel: {since, bySource, total}, totals};
}
