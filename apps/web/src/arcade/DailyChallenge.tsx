import {useEffect, useState} from 'react';
import {ArrowUpRight, Check, Flag, Stamp, Store, Sun} from 'lucide-react';
import type {GameId} from '@mapae/arcade';
import {dailyChallenge} from '@mapae/arcade/challenge';
import type {ArcadeState} from './state';
import {GAME_NAMES} from './game-names';
import './outing.css';

const games = ['race', 'shop', 'stamp'] as const;
const icons = {race: Flag, shop: Store, stamp: Stamp};
export function DailyChallenge({demo, ko, onPlay}: {demo: ArcadeState; ko: boolean; onPlay: (game: GameId, seed: number) => void}) {
    const [now, setNow] = useState<number | null>(null);
    useEffect(() => {
        const refresh = () => setNow(Date.now());
        refresh(); const timer = setInterval(refresh, 60_000); window.addEventListener('focus', refresh);
        return () => {clearInterval(timer); window.removeEventListener('focus', refresh);};
    }, []);
    const names = GAME_NAMES[ko ? 'ko' : 'en'];
    return <section className="arc-daily" aria-labelledby="daily-title">
        <div className="arc-section-title"><div><span className="arc-overline"><Sun size={15}/> DAILY CHALLENGE</span><h2 id="daily-title">{ko ? '오늘은 어떤 기록을 남길까요?' : 'A fresh challenge, every day'}</h2><p>{ko ? '모두 같은 조건 · 직접 플레이 · 무료' : 'Same scenario for everyone · Human play · Free'}</p></div><small>{now === null ? '—' : dailyChallenge('race', now).day}<br/>{ko ? '매일 자정 새로 열려요 (한국 시간)' : 'New scenarios at midnight, Korea time'}</small></div>
        <div className="arc-daily-games">{games.map(game => {
            const challenge = now === null ? null : dailyChallenge(game, now);
            const scores = challenge ? game === 'stamp'
                ? demo.runs.filter(r => r.characterId === demo.selectedCharacterId && r.status === 'complete' && r.ruleset === challenge.version && r.replaySeed === challenge.seed).map(r => r.score)
                : demo.activities.filter(a => a.characterId === demo.selectedCharacterId && a.source === 'practice' && a.status === 'complete' && a.game === game && a.outcome?.replay?.version === challenge.version && a.outcome.replay.seed === challenge.seed).map(a => a.outcome!.score) : [];
            const Icon = icons[game];
            return <button className={`arc-daily-game is-${game}`} key={game} disabled={!demo.selectedCharacterId || !challenge} onClick={() => challenge && onPlay(game, challenge.seed)}><Icon size={25}/><strong>{names[game]}</strong><span>{scores.length ? <><Check size={14}/>{ko ? '내 기록' : 'My best'} {Math.max(...scores)}</> : ko ? '오늘의 한 판 시작' : 'Play today’s scenario'}<ArrowUpRight size={17}/></span></button>;
        })}</div>
        {!demo.selectedCharacterId && <a className="arc-inline-link" href="#arcade-crew">{ko ? '먼저 나만의 친구를 만들어 주세요' : 'Create your character to begin'} →</a>}
    </section>;
}
