import {describe, expect, test} from 'bun:test';
import {MOCK_USDC} from '@mapae/shared';
import {faucetUrl} from '../lib/config';
import {localizeUrl} from '../lib/i18n';
import {FAUCET_HINT, faucetHintUrl} from './faucet-hint';

describe('arcade faucet hint', () => {
    test('names both tokens as testnet and the follow as what unlocks them, in both languages', () => {
        for (const locale of ['ko', 'en'] as const) {
            const hint = FAUCET_HINT[locale];
            expect(hint.need).toContain('GIWA Sepolia ETH');
            expect(hint.need).toContain(MOCK_USDC.symbol);
            expect(hint.need).toMatch(/실제 돈이 아니에요|not real money/);
            for (const line of [hint.unlock, hint.gas]) {
                expect(line).toContain('@mapae_io');
                expect(line).toContain('faucet.mapae.io');
            }
            expect(hint.gas).toContain('GIWA Sepolia ETH');
        }
    });

    test('the link opens the faucet in the reader\'s language, on the ETH tab only when gas is what is missing', () => {
        expect(faucetHintUrl('ko')).toBe(`${localizeUrl(faucetUrl, 'ko')}#eth`);
        expect(faucetHintUrl('en', 'musdc')).toBe(localizeUrl(faucetUrl, 'en'));
        expect(faucetHintUrl('en', 'musdc')).not.toContain('#');
    });
});
