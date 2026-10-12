import {lazy, Suspense, type ReactNode} from 'react';
import type {Locale} from '../lib/i18n';

// Guest and NFT practice share the same chunks. Choosing one game must not
// download the other two engines, their effects or their styles.
export const Arena = lazy(() => import('./Arena').then(m => ({default: m.Arena})));
export const RaceGame = lazy(() => import('./race/RaceGame').then(m => ({default: m.RaceGame})));
export const ShopGame = lazy(() => import('./shop/ShopGame').then(m => ({default: m.ShopGame})));

export function GameViewport({locale, children}: {locale: Locale; children: ReactNode}) {
    return <Suspense fallback={<div className="arc-game-loading" role="status">{locale === 'ko' ? '놀이를 준비하고 있어요…' : 'Getting your game ready…'}</div>}>{children}</Suspense>;
}
