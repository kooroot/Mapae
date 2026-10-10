import type {GameId} from '@mapae/arcade';
import {ArrowRight, Info} from 'lucide-react';
import {useLocale} from '../../lib/locale';
import {PracticeArcade, type PracticeStore} from '../PracticeArcade';
import {trackEngagement} from '../engagement/client';
import './guest.css';

export function GuestArcade({game, store, onBack, onGuardian}: {game: GameId; store: PracticeStore; onBack: () => void; onGuardian: (game: GameId) => void}) {
    const {locale} = useLocale(), ko = locale === 'ko';
    return <PracticeArcade initialGame={game} store={store} character={store.demo.characters[0]!} onBack={onBack}
        syncStatus={<p className="guest-local-note"><Info size={16} aria-hidden="true" />{ko ? '체험 전령 · 이 탭에만 연습 기록이 남아요. NFT 성장 기록과는 별개예요.' : 'Trial guardian · Practice records stay in this tab, separate from NFT growth.'}</p>}
        resultAction={selected => <div className="guest-conversion"><div><strong>{ko ? '다음 모험은 나의 전령과' : 'Your next adventure, with your own guardian'}</strong><p>{ko ? '지갑을 연결해 내 전령을 만나고, 용돈과 작전을 정해 보세요.' : 'Connect a wallet to meet your guardian, set an allowance and choose a strategy.'}</p></div><button className="arc-button" onClick={() => {trackEngagement({event: 'guardian_cta', game: selected, locale}); onGuardian(selected);}}>{ko ? '내 전령 만나러 가기' : 'Meet my guardian'}<ArrowRight size={19} /></button></div>}
        onPracticeEvent={event => trackEngagement({...event, locale})} />;
}
