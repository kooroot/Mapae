import {Crown, Trophy} from 'lucide-react';
import type {GameId} from '@mapae/arcade';
import type {GuardianStanding} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {GAME_NAMES} from '../game-names';
import {rankLine, titleName} from './format';
import {RankMedal} from './RankMedal';
import './ranking.css';

/** One game's rank line for a guardian: today's place, the gap above, and the ranked tries left. Nothing until standings load. */
export function RankLine({locale, game, guardian, leader, named = true, aptitude}: {
    locale: Locale; game: GameId; guardian: GuardianStanding | undefined; leader: number | null; named?: boolean;
    /** The guardian's born aptitude for this game, marked when it is their strongest. */
    aptitude?: {value: number; best: boolean};
}) {
    if (!guardian) return null;
    const {attemptsUsed, today} = guardian.games[game];
    // A podium place shows its medal; the line itself still says the place in words.
    return <p className="rank-line">{today && today.rank <= 3 ? <RankMedal rank={today.rank} locale={locale} size="sm" decorative /> : <Trophy size={15} aria-hidden="true" />}
        {named && <b>{GAME_NAMES[locale][game]}</b>}
        {aptitude && <small className={`rank-aptitude${aptitude.best ? ' is-best' : ''}`}>{locale === 'ko' ? '적성' : 'Aptitude'} {aptitude.value}/6</small>}
        <span>{rankLine({locale, attemptsUsed, standing: today, leader})}</span>
    </p>;
}

/** Last week's places as titles (장원 · 급제 · 입격) in gold, silver and bronze, one per game; cosmetic only. */
export function TitleChips({locale, titles}: {locale: Locale; titles: GuardianStanding['titles']}) {
    if (!titles.length) return null;
    return <ul className="rank-titles" aria-label={locale === 'ko' ? '지난주 칭호' : 'Last week’s titles'}>
        {titles.map(t => <li key={t.game} className={`is-place-${t.place === 1 ? 1 : t.place <= 3 ? 2 : 3}`}>
            {t.place === 1 && <Crown size={13} aria-hidden="true" />}{titleName(t.place, locale)} · {GAME_NAMES[locale][t.game]}
        </li>)}
    </ul>;
}
