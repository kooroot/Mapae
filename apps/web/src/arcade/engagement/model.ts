import type {GameId} from '@mapae/arcade';
export const DAY_MS = 86_400_000;
export const RAW_RETENTION_MS = 35 * DAY_MS;
export const VISITOR_TTL_MS = 90 * DAY_MS;
export const MAX_EVENT_BYTES = 2048;
export const ENGAGEMENT_LIMITS = {visitorDay: 200, ipMinute: 120, globalDay: 100_000} as const;
export type PracticeEvent = {event: 'practice_opened'; game: GameId; runId: string} | {event: 'practice_finished'; game: GameId; runId: string; result: 'completed' | 'ended_early' | 'abandoned'};
/** Arriving at a page is a funnel stage, never deliberate interaction: DAU and retention leave these out. */
export const PASSIVE_EVENTS = ['landing_viewed', 'arcade_entered', 'faucet_opened'] as const;
/** Events that carry nothing beyond who sent them: no game, run or result. */
const BARE_EVENTS = ['landing_viewed', 'faucet_opened', 'operator_action', 'mint_started', 'outing_started'] as const;
export type ClientEvent = PracticeEvent | {event: 'arcade_entered' | 'guardian_cta'; game?: GameId} | {event: typeof BARE_EVENTS[number]; game?: never};
/** Recorded by the server after it verified the wallet, never accepted from a browser. */
export type ServerEvent = 'profile_authenticated' | 'faucet_musdc_claimed' | 'faucet_eth_claimed';
/** Where a browser first came from: an explicit `?ref=`, else the referring site. */
export const REF_SOURCES = ['x', 'telegram', 'discord', 'kakao', 'giwa', 'share', 'landing', 'arcade'] as const;
export const TRAFFIC_SOURCES = [...REF_SOURCES, 'internal', 'other', 'direct'] as const;
export type TrafficSource = typeof TRAFFIC_SOURCES[number];
export type EngagementInput = ClientEvent & {version: 1; id: string; locale: 'ko' | 'en'; source: TrafficSource};
export type StoredEngagement = {id: string; visitor: string; session: string; owner: string | null; event: EngagementInput['event'] | ServerEvent; game: GameId | null; runId: string | null; result: 'completed' | 'ended_early' | 'abandoned' | null; locale: 'ko' | 'en' | 'und'; at: number; day: string; trust: 'client_reported' | 'server_authenticated'};
const REFERRERS: [RegExp, TrafficSource][] = [
    [/(^|\.)(x\.com|twitter\.com|t\.co)$/, 'x'], [/(^|\.)(t\.me|telegram\.me|telegram\.org)$/, 'telegram'],
    [/(^|\.)(discord\.com|discord\.gg|discordapp\.com)$/, 'discord'], [/(^|\.)kakao\.com$/, 'kakao'], [/(^|\.)giwa\.io$/, 'giwa'], [/(^|\.)mapae\.io$/, 'internal'],
];
/** An unknown `?ref=` or referring site is `other`; no hint at all is `direct`. */
export function trafficSource(search: string, referrer: string): TrafficSource {
    const ref = new URLSearchParams(search).get('ref')?.toLowerCase();
    if (ref !== undefined) return (REF_SOURCES as readonly string[]).includes(ref) ? ref as TrafficSource : 'other';
    let host: string;
    try {host = new URL(referrer).hostname.toLowerCase();} catch {return 'direct';}
    return REFERRERS.find(([pattern]) => pattern.test(host))?.[1] ?? 'other';
}
export const seoulDay = (at: number): string => new Date(at + 9 * 3_600_000).toISOString().slice(0, 10);
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseEngagement(input: unknown): EngagementInput | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const v = input as Record<string, unknown>;
    if (Object.keys(v).some(k => !['version', 'id', 'event', 'game', 'runId', 'result', 'locale', 'source'].includes(k)) || v.version !== 1 || typeof v.id !== 'string' || !UUID.test(v.id) || (v.locale !== 'ko' && v.locale !== 'en')) return null;
    if (typeof v.source !== 'string' || !(TRAFFIC_SOURCES as readonly string[]).includes(v.source)) return null;
    if (v.game !== undefined && (typeof v.game !== 'string' || !['stamp', 'race', 'shop'].includes(v.game))) return null;
    if (v.event === 'practice_opened' || v.event === 'practice_finished') {
        if (!v.game || typeof v.runId !== 'string' || !UUID.test(v.runId)) return null;
        if (v.event === 'practice_finished' ? typeof v.result !== 'string' || !['completed', 'ended_early', 'abandoned'].includes(v.result) : v.result !== undefined) return null;
    } else if (v.runId !== undefined || v.result !== undefined) return null;
    else if (v.event !== 'arcade_entered' && v.event !== 'guardian_cta' && (!(BARE_EVENTS as readonly unknown[]).includes(v.event) || v.game !== undefined)) return null;
    return input as EngagementInput;
}
