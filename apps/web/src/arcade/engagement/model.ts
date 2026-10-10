import type {GameId} from '@mapae/arcade';
export const DAY_MS = 86_400_000;
export const RAW_RETENTION_MS = 35 * DAY_MS;
export const VISITOR_TTL_MS = 90 * DAY_MS;
export const MAX_EVENT_BYTES = 2048;
export const ENGAGEMENT_LIMITS = {visitorDay: 200, ipMinute: 120, globalDay: 100_000} as const;
export type PracticeEvent = {event: 'practice_opened'; game: GameId; runId: string} | {event: 'practice_finished'; game: GameId; runId: string; result: 'completed' | 'ended_early' | 'abandoned'};
export type ClientEvent = PracticeEvent | {event: 'arcade_entered' | 'guardian_cta'; game?: GameId} | {event: 'operator_action'; game?: never};
export type EngagementInput = ClientEvent & {version: 1; id: string; locale: 'ko' | 'en'};
export type StoredEngagement = {id: string; visitor: string; session: string; owner: string | null; event: EngagementInput['event'] | 'profile_authenticated'; game: GameId | null; runId: string | null; result: 'completed' | 'ended_early' | 'abandoned' | null; locale: 'ko' | 'en' | 'und'; at: number; day: string; trust: 'client_reported' | 'server_authenticated'};
export const seoulDay = (at: number): string => new Date(at + 9 * 3_600_000).toISOString().slice(0, 10);
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseEngagement(input: unknown): EngagementInput | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const v = input as Record<string, unknown>;
    if (Object.keys(v).some(k => !['version', 'id', 'event', 'game', 'runId', 'result', 'locale'].includes(k)) || v.version !== 1 || typeof v.id !== 'string' || !UUID.test(v.id) || (v.locale !== 'ko' && v.locale !== 'en')) return null;
    if (v.game !== undefined && (typeof v.game !== 'string' || !['stamp', 'race', 'shop'].includes(v.game))) return null;
    if (v.event === 'practice_opened' || v.event === 'practice_finished') {
        if (!v.game || typeof v.runId !== 'string' || !UUID.test(v.runId)) return null;
        if (v.event === 'practice_finished' ? typeof v.result !== 'string' || !['completed', 'ended_early', 'abandoned'].includes(v.result) : v.result !== undefined) return null;
    } else if ((v.event !== 'arcade_entered' && v.event !== 'guardian_cta' && v.event !== 'operator_action') || v.runId !== undefined || v.result !== undefined || (v.event === 'operator_action' && v.game !== undefined)) return null;
    return input as EngagementInput;
}
