import type {AgentGoal, GameId} from '@mapae/arcade';
import {MAX_OUTING_ADMISSIONS} from '@mapae/arcade/outings';
import {guardianTokenId} from '@mapae/arcade/guardians';
import {isAddress, isHex} from 'viem';

export type OutingSubmission = {id: string; tokenId: string; goal: AgentGoal; choice: GameId | 'auto'; admissions: number; permissionContext: `0x${string}`; locale: 'ko' | 'en'};
const key = (owner: string) => {
    if (!isAddress(owner)) throw new Error('Invalid owner');
    return `mapae.outing-submission.${owner.toLowerCase()}`;
};
export function parseSubmission(value: unknown): OutingSubmission {
    if (!value || typeof value !== 'object') throw new Error('Invalid outing request');
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(v.id) ||
        !guardianTokenId(v.tokenId) || !['explore','score','save'].includes(String(v.goal)) || !['auto','race','shop','stamp'].includes(String(v.choice)) ||
        typeof v.admissions !== 'number' || !Number.isInteger(v.admissions) || v.admissions < 1 || v.admissions > MAX_OUTING_ADMISSIONS ||
        typeof v.permissionContext !== 'string' || v.permissionContext.length > 24000 || !isHex(v.permissionContext) || v.permissionContext.length % 2 !== 0 || v.permissionContext.length < 4 ||
        !['ko','en'].includes(String(v.locale))) throw new Error('Invalid outing request');
    return {id:v.id,tokenId:v.tokenId,goal:v.goal as AgentGoal,choice:v.choice as OutingSubmission['choice'],admissions:v.admissions,permissionContext:v.permissionContext as `0x${string}`,locale:v.locale as 'ko'|'en'};
}
/** Only a public root permission is retained. The server agent key never enters this browser. */
export function saveSubmission(owner: string, v: OutingSubmission) {localStorage.setItem(key(owner), JSON.stringify(parseSubmission(v)));}
export function readSubmission(owner: string): OutingSubmission | null {
    const raw = localStorage.getItem(key(owner));
    return raw ? parseSubmission(JSON.parse(raw)) : null;
}
export function clearSubmission(owner: string) {localStorage.removeItem(key(owner));}
