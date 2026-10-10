import {afterEach, expect, test} from 'bun:test';
import {clearSubmission, parseSubmission, readSubmission, saveSubmission, type OutingSubmission} from './outing-submission';

const owner = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const input: OutingSubmission = {generation: 'g1', id: '12345678-1234-1234-1234-123456789012', tokenId: '1', goal: 'score', choice: 'auto', admissions: 5, permissionContext: '0xabcd', locale: 'ko'};
const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {if (prior) Object.defineProperty(globalThis, 'localStorage', prior); else Reflect.deleteProperty(globalThis, 'localStorage');});
function storage() {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k)}});
    return values;
}
test('reload retries the same public permission and request; wallets remain isolated', () => {
    const values = storage();
    saveSubmission(owner, {...input, privateKey: 'must-not-persist', provider: {secret: 'also-secret'}} as OutingSubmission);
    expect(readSubmission(owner)).toEqual(input);
    expect(readSubmission(other)).toBeNull();
    expect([...values.values()][0]).not.toMatch(/privateKey|must-not-persist|provider|also-secret/);
    clearSubmission(other); expect(readSubmission(owner)).toEqual(input);
    clearSubmission(owner); expect(readSubmission(owner)).toBeNull();
});
test('malformed limits, identity, context and blocked storage refuse dispatch', () => {
    storage();
    for (const patch of [{admissions: 0}, {admissions: 37}, {admissions: 1.1}, {permissionContext: '0x123'}, {permissionContext: 'secret'}, {id: '../a'}, {tokenId: '../b'}, {tokenId: '0'}, {tokenId: '01'}, {goal:'random'}, {choice: 'external'}, {locale: 'zh'}]) expect(() => parseSubmission({...input, ...patch})).toThrow();
    expect(() => saveSubmission('invalid-owner', input)).toThrow();
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {setItem: () => {throw new Error('storage_full');}}});
    expect(() => saveSubmission(owner, input)).toThrow('storage_full');
});
