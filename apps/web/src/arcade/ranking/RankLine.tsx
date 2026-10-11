import {Crown, Trophy} from 'lucide-react';
import type {GameId} from '@mapae/arcade';
import type {GuardianStanding} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {GAME_NAMES} from '../game-names';
import {rankLine, titleName} from './format';
import './ranking.css';

/** One game's rank line for a guardian: today's place, the gap above, and the ranked tries left. Nothing until standings load. */
export function RankLine({locale, game, guardian, leader, named = true}: {
    locale: Locale; game: GameId; guardian: GuardianStanding | undefined; leader: number | null; named?: boolean;
}) {
    if (!guardian) return null;
    const {attemptsUsed, today} = guardian.games[game];
    return <p className="rank-line"><Trophy size={15} aria-hidden="true" />
        {named && <b>{GAME_NAMES[locale][game]}</b>}
        <span>{rankLine({locale, attemptsUsed, standing: today, leader})}</span>
    </p>;
}

/** Last week's places as titles (장원 · 급제 · 입격), one per game; cosmetic only. */
export function TitleChips({locale, titles}: {locale: Locale; titles: GuardianStanding['titles']}) {
    if (!titles.length) return null;
    return <ul className="rank-titles" aria-label={locale === 'ko' ? '지난주 칭호' : 'Last week’s titles'}>
        {titles.map(t => <li key={t.game} className={t.place === 1 ? 'is-champion' : undefined}>
            {t.place === 1 && <Crown size={13} aria-hidden="true" />}{titleName(t.place, locale)} · {GAME_NAMES[locale][t.game]}
        </li>)}
    </ul>;
}
