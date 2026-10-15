import {useEffect, useRef} from 'react';
import {Coffee, Dices, Users} from 'lucide-react';
import {guardianName} from '@mapae/arcade/guardians';
import {seasonMarks, type SealedHall} from '@mapae/arcade/hall';
import type {RankingBoard} from '@mapae/arcade/ranking';
import {guardianAsset} from '../guardian';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {Board} from './Board';
import {Portrait} from './BoardRow';
import {championCopy, closeBlockCopy, hallChip, prizeNotes, raffleFormula, streakEntrantCopy, teamWinnerCopy} from './format';
import {SeasonMarks, seasonMarkShortName} from './SeasonMark';

/**
 * What a sealed season leaves behind, as the seller sealed it: the podium with its marks, the winning team, each week's
 * champions, the 7-day-streak raffle (the pool, the block that seeded it, the draw anyone can recompute), the marks my guardians
 * wear, and how prizes reach the winners. `#hall` in the URL scrolls here once the section has rendered.
 */
export function HallOfFame({desk, hall}: {desk: GuardianDesk; hall: SealedHall}) {
    const {ko, locale, revealed} = desk, section = useRef<HTMLElement>(null);
    useEffect(() => {if (window.location.hash === '#hall') section.current?.scrollIntoView({block: 'start'});}, []);
    const mine = new Set(revealed.map(t => t.tokenId)), marksOf = (row: {tokenId: string; seed: `0x${string}`}) => seasonMarks(hall, row.tokenId, row.seed);
    const podium: RankingBoard = {board: 'season', period: `s${hall.season}`, from: hall.start, to: hall.end, closesAt: null, entrants: hall.entrants, moves: false,
        rows: hall.podium.map(row => ({rank: row.rank, tokenId: row.tokenId, seed: row.seed, score: row.points, prev: null, days: row.days}))};
    const worn = revealed.map(token => ({token, marks: desk.marksOf(token.tokenId)})).filter(({marks}) => marks.length);
    const winners = new Set(hall.raffle);
    return <section ref={section} id="hall" className="nft-panel rank-board rank-hall" aria-labelledby="rank-hall-title">
        <div className="rank-board-head">
            <div><span className="arc-overline">{ko ? '명예의 전당' : 'Hall of fame'}</span><h2 id="rank-hall-title">{ko ? `시즌 ${hall.season} 명예의 전당` : `Season ${hall.season} hall of fame`}</h2></div>
            <div className="rank-chips"><span className="rank-chip"><Users size={15} aria-hidden="true" />{hallChip(hall, locale)}</span></div>
        </div>
        <Board board={podium} mine={mine} locale={locale} marksOf={marksOf} />
        <h3 className="rank-hall-heading">{hall.teams.length > 1 ? ko ? '공동 우승 팀' : 'Shared first · teams' : ko ? '우승 팀' : 'Winning team'}</h3>
        <ul className="rank-hall-list">
            {hall.teams.map(team => <li key={team.zodiac}><img src={guardianAsset(team.zodiac, 256)} alt="" width={40} height={40} loading="lazy" decoding="async" /><span>{teamWinnerCopy(team, locale)}</span></li>)}
        </ul>
        <h3 className="rank-hall-heading">{ko ? '주간 장원' : 'Weekly champions'}</h3>
        {hall.champions.length ? <ul className="rank-hall-list">
            {hall.champions.map(champion => <li key={`${champion.week}-${champion.game}`}><Portrait row={{rank: 1, tokenId: champion.tokenId, seed: champion.seed, score: champion.score}} /><span>{championCopy(champion, locale)}</span></li>)}
        </ul> : <p className="rank-team-note">{ko ? '이번 시즌에는 주간 장원이 없었어요.' : 'No weekly champion this season.'}</p>}
        <h3 className="rank-hall-heading">{ko ? '7일 연속 출석 추첨' : '7-day streak raffle'}</h3>
        <p className="rank-team-note rank-hall-note"><Dices size={16} aria-hidden="true" /><span>{raffleFormula(locale)} · {closeBlockCopy(hall.closeBlock, locale)}</span></p>
        {hall.streakPool.length ? <ul className="rank-hall-list rank-hall-pool" aria-label={ko ? '추첨 풀' : 'Raffle pool'}>
            {hall.streakPool.map(entrant => <li key={entrant.tokenId} className={winners.has(entrant.tokenId) ? 'is-winner' : undefined}>
                <Portrait row={{rank: 0, tokenId: entrant.tokenId, seed: entrant.seed, score: 0}} /><span>{streakEntrantCopy(entrant.tokenId, entrant.runs, locale)}</span>
                {winners.has(entrant.tokenId) && <b className="rank-mine-tag">{ko ? '당첨' : 'Winner'}</b>}
            </li>)}
        </ul> : <p className="rank-team-note">{ko ? '7일 연속 출석을 완주한 전령이 없어 추첨은 없었어요.' : 'Nobody completed a 7-day run, so there was no draw.'}</p>}
        {worn.length > 0 && <ul className="rank-hall-mine" aria-label={ko ? '내 전령의 문양' : 'My guardians’ marks'}>
            {worn.map(({token, marks}) => <li key={token.tokenId}><SeasonMarks marks={marks} locale={locale} />
                <span>{`${ko ? '내 전령' : 'My guardian'} ${guardianName(token.tokenId, locale)}: ${marks.map(mark => seasonMarkShortName(mark, locale)).join(' · ')}`}</span></li>)}
        </ul>}
        <h3 className="rank-hall-heading">{ko ? '상품 전달' : 'Prizes'}</h3>
        <ul className="rank-season-intro">{prizeNotes(locale).map((item, i) => <li key={item}>{i === 0 ? <Coffee size={16} aria-hidden="true" /> : <span className="rank-season-dot" aria-hidden="true" />}<span>{item}</span></li>)}</ul>
    </section>;
}
