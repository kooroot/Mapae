import {expect, test} from 'bun:test';
import {dailyChallenge} from './challenge';

test('daily scenarios roll over at Korean midnight, not browser midnight', () => {
    const before = Date.parse('2026-10-04T14:59:59.999Z');
    expect(dailyChallenge('race', before).day).toBe('2026-10-04');
    expect(dailyChallenge('race', before + 1).day).toBe('2026-10-05');
    expect(dailyChallenge('race', before).seed).not.toBe(dailyChallenge('race', before + 1).seed);
    expect(dailyChallenge('race', before).seed).toBe(dailyChallenge('race', before - 80_000_000).seed);
});
test('all games have independent stable uint32 scenarios', () => {
    const values = ['race', 'shop', 'stamp'].map(game => dailyChallenge(game as 'race', 0).seed);
    expect(new Set(values).size).toBe(3);
    expect(values.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff)).toBe(true);
    expect(() => dailyChallenge('race', NaN)).toThrow();
});
