import {expect, test} from 'bun:test';
import {readFundedBalance} from './giwa-readiness';

test('a confirmed bootstrap waits through stale and unavailable balance reads without another write', async () => {
    const values = [0n, undefined, 1_000_000n];
    let reads = 0, waits = 0;
    expect(await readFundedBalance(async () => {reads++; return values.shift();}, 1_000_000n, async () => {waits++;})).toBe(1_000_000n);
    expect(reads).toBe(3); expect(waits).toBe(2);
});

test('readiness stays bounded and never treats an insufficient or unavailable balance as funded', async () => {
    let reads = 0;
    expect(await readFundedBalance(async () => {reads++; return 999_999n;}, 1_000_000n, async () => {})).toBe(999_999n);
    expect(reads).toBe(6);
    expect(await readFundedBalance(async () => undefined, 1_000_000n, async () => {})).toBeUndefined();
});
