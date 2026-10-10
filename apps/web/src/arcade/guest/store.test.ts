import {describe, expect, test} from 'bun:test';
import {admitPracticeRun, finishPracticeRun} from '../state';
import {newGuestState, parseGuestState, serializeGuestState, guestUpdate, MAX_GUEST_BYTES} from './store';

describe('isolated guest practice', () => {
    test('ready preset admits a real local round and update synchronously returns results without browser storage', () => {
        const current = {current: newGuestState()};
        const admission = admitPracticeRun(current.current, crypto.randomUUID(), 100);
        if (!admission.ok) throw new Error('guest should enter');
        guestUpdate(current, () => admission.demo);
        const next = guestUpdate(current, state => finishPracticeRun(state, admission.ticket.id, {score: 100, bestCombo: 1, hits: 1, mistakes: 0, missed: 0}));
        expect(current.current).toBe(next);
        expect(next.runs[0]?.score).toBe(100);
        expect(next.characters[0]?.best).toBe(100);
    });
    test('credential projection excludes unknown nested fields and wallet material', () => {
        const state = newGuestState();
        Object.assign(state, {owner: '0x123', privateKey: 'SECRET', wallet: {signature: 'SECRET'}});
        Object.assign(state.characters[0]!, {privateKey: 'SECRET'});
        Object.assign(state.characters[0]!.agent, {permissionContext: 'SECRET'});
        const raw = serializeGuestState(state);
        expect(raw).not.toContain('SECRET'); expect(raw).not.toContain('0x123');
        expect(parseGuestState(raw).characters[0]?.id).toBe('guest');
    });
    test('rejects malformed, oversized, wallet-scoped and paid snapshots', () => {
        for (const raw of ['{', 'x'.repeat(MAX_GUEST_BYTES + 1), JSON.stringify({...newGuestState(), selectedCharacterId: 'owner'}), JSON.stringify({...newGuestState(), characters: []})]) {
            expect(parseGuestState(raw).characters[0]?.id).toBe('guest');
            expect(parseGuestState(raw).activities).toEqual([]);
        }
        const state = newGuestState();
        (state.activities as unknown[]).push({source: 'mapae-giwa'});
        expect(() => serializeGuestState(state)).toThrow('Invalid guest state');
        expect(parseGuestState(JSON.stringify(state)).activities).toEqual([]);
    });
    test('caps and projects local run history', () => {
        let state = newGuestState();
        for (let i = 0; i < 60; i++) {const a = admitPracticeRun(state, crypto.randomUUID(), i); if (a.ok) state = a.demo;}
        expect(parseGuestState(serializeGuestState(state)).runs).toHaveLength(40);
        expect(new TextEncoder().encode(serializeGuestState(state)).length).toBeLessThan(MAX_GUEST_BYTES);
    });
});
