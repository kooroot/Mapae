import {afterEach, expect, test} from 'bun:test';
import {ProfileError, readSession} from './client';

const owner = '0x1111111111111111111111111111111111111111';
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = originalFetch;});
function respond(value: unknown, status = 200, inspect?: (url: string, init: RequestInit) => void) {
    globalThis.fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
        inspect?.(String(url), init!);
        return Response.json(value, {status});
    }, {preconnect: originalFetch.preconnect});
}
test('session check only requests wallet identity, with no character snapshot or write', async () => {
    let calls = 0;
    respond({owner}, 200, (url, init) => {
        calls++;
        expect(url).toBe('/api/arcade/profile/session');
        expect(init.method).toBe('GET'); expect(init.body).toBeUndefined();
        expect(new Headers(init.headers).get('X-Mapae-Wallet')).toBe(owner);
    });
    await readSession(owner); expect(calls).toBe(1);
});
test('session check rejects a missing, mismatched or malformed wallet identity', async () => {
    for (const value of [{profile: {characters: [{id: 'old-friend'}]}}, {owner: '0x2222222222222222222222222222222222222222'}, {owner: 'invalid'}, null]) {
        respond(value); await expect(readSession(owner)).rejects.toThrow('invalid_response');
    }
});
test('expired sessions require sign-in without a profile import attempt', async () => {
    respond({error: {code: 'login_required'}}, 401);
    await expect(readSession(owner)).rejects.toMatchObject({code: 'login_required'} satisfies Partial<ProfileError>);
});
