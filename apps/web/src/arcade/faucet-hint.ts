import {MOCK_USDC} from '@mapae/shared';
import {faucetUrl} from '../lib/config';
import {localizeUrl, type Locale} from '../lib/i18n';

/**
 * What a newcomer needs before the arcade costs anything, said once in one line: GIWA Sepolia ETH to draw a guardian,
 * the test stablecoin to play, both free at faucet.mapae.io for a follow of @mapae_io. `gas` is the sentence any
 * onchain request (a draw, a record, a recovery) that could not be sent for lack of ETH shows, pointing at the same door.
 */
export const FAUCET_HINT: Record<Locale, {need: string; unlock: string; action: string; gas: string}> = {
    ko: {
        need: `전령 뽑기엔 GIWA Sepolia ETH, 놀이엔 ${MOCK_USDC.symbol}가 필요해요 — 둘 다 테스트넷 토큰이고 실제 돈이 아니에요.`,
        unlock: 'faucet.mapae.io에서 @mapae_io를 팔로우하면 테스트 토큰을 무료로 받아요.',
        action: '팔로우하고 테스트 토큰 받기',
        gas: '지갑에 GIWA Sepolia ETH(테스트넷)가 모자라 보내지 못했어요. faucet.mapae.io에서 @mapae_io를 팔로우하면 무료로 받아요.',
    },
    en: {
        need: `Drawing a guardian takes GIWA Sepolia ETH and playing takes ${MOCK_USDC.symbol} — both testnet tokens, not real money.`,
        unlock: 'Follow @mapae_io on faucet.mapae.io and the test tokens are free.',
        action: 'Follow and get test tokens',
        gas: 'Your wallet is short of GIWA Sepolia ETH (testnet), so nothing was sent. Follow @mapae_io on faucet.mapae.io to get it free.',
    },
};

/** The faucet in the reader's language, opened on the ETH tab when gas is what they are missing. */
export const faucetHintUrl = (locale: Locale, kind: 'eth' | 'musdc' = 'eth') => `${localizeUrl(faucetUrl, locale)}${kind === 'eth' ? '#eth' : ''}`;
