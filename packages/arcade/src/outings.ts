import type {ActivityOutcome, AgentProfile, GameId} from './contracts';
import type {GuardianSnapshot} from './guardians';
import type {RankedAttempt} from './ranking';

export const MAX_OUTING_ADMISSIONS = 36;
export const OUTING_PERMISSION_SECONDS = 7200;
export type OutingStart = {
    id: string; tokenId: string; goal: AgentProfile['goal']; locale: 'ko' | 'en';
    choice: GameId | 'auto'; admissions: number; permissionContext: `0x${string}`;
};
/** `ranked` names the ranked attempt a round was; absent, the round grew the guardian without entering a board. */
export type OutingResult = {id: string; game: GameId; seed: number; at: number; transaction: `0x${string}`; outcome: ActivityOutcome; ranked?: RankedAttempt};
export type OutingView = {
    id: string; characterId: string; guardian: GuardianSnapshot; profile: AgentProfile; locale: 'ko' | 'en'; choice: GameId | 'auto';
    status: 'queued' | 'running' | 'paused' | 'stopped' | 'complete'; admissions: number;
    spent: number; reservedAdmissions: number; createdAt: number; updatedAt: number; expiresAt: number;
    error: string | null; results: OutingResult[];
};
export type OutingStatus = {enabled: boolean; agent: `0x${string}` | null; jobs: OutingView[]};
