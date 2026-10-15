import {Check, Crown, Trophy} from 'lucide-react';
import {GAME_NAMES, type GameId} from '@mapae/arcade';
import type {GuardianStanding} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {rankLine, titleName} from './format';
import {RankMedal} from './RankMedal';
import {RankMove} from './RankMove';
import './ranking.css';

/**
 * One game's rank line for a guardian: today's place and its move since yesterday, the gap above, and the ranked tries left;
 * with `weekly`, also this week's place and its move since last week. Nothing until standings load.
 */
export function RankLine({locale, game, guardian, leader, named = true, aptitude, weekly = false}: {
    locale: Locale; game: GameId; guardian: GuardianStanding | undefined; leader: number | null; named?: boolean;
    /** The guardian's born aptitude for this game, marked when it is their strongest. */
    aptitude?: {value: number; best: boolean};
    weekly?: boolean;
}) {
    if (!guardian) return null;
    const {attemptsUsed, today, week} = guardian.games[game];
    // A podium place shows its medal; the line itself still says the place in words.
    return <p className="rank-line">{today && today.rank <= 3 ? <RankMedal rank={today.rank} locale={locale} size="sm" decorative /> : <Trophy size={15} aria-hidden="true" />}
        {named && <b>{GAME_NAMES[locale][game]}</b>}
        {aptitude && <small className={`rank-aptitude${aptitude.best ? ' is-best' : ''}`}>{locale === 'ko' ? '적성' : 'Aptitude'} {aptitude.value}/6</small>}
        {today && <RankMove rank={today.rank} move={today} period="today" locale={locale} />}
        <span>{rankLine({locale, attemptsUsed, standing: today, leader})}</span>
        {weekly && week && <small className="rank-week">{locale === 'ko' ? `이번 주 ${week.rank}위` : `#${week.rank} this week`}<RankMove rank={week.rank} move={week} period="week" locale={locale} /></small>}
    </p>;
}

/** Last week's places as titles (장원 · 급제 · 입격) in gold, silver and bronze, one per game; cosmetic, and checked once on the NFT. */
export function TitleChips({locale, titles, onNft = false}: {locale: Locale; titles: GuardianStanding['titles']; onNft?: boolean}) {
    if (!titles.length) return null;
    const recorded = locale === 'ko' ? 'NFT에 기록됨' : 'On the NFT';
    return <ul className="rank-titles" aria-label={locale === 'ko' ? '지난주 칭호' : 'Last week’s titles'}>
        {titles.map(t => <li key={t.game} className={`is-place-${t.place === 1 ? 1 : t.place <= 3 ? 2 : 3}`}>
            {t.place === 1 && <Crown size={13} aria-hidden="true" />}{titleName(t.place, locale)} · {GAME_NAMES[locale][t.game]}
            {onNft && <span className="rank-title-nft" title={recorded}><Check size={13} aria-hidden="true" /><span className="sr-only">{recorded}</span></span>}
        </li>)}
    </ul>;
}
