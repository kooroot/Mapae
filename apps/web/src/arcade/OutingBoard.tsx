import {useState} from 'react';
import {ArrowUpRight, Check, Compass, Pause, RefreshCw} from 'lucide-react';
import type {OutingView} from '@mapae/arcade/outings';
import {ConfirmDialog} from '../components/ConfirmDialog';
import type {useGiwaTickets} from './useGiwaTickets';
import type {ArcadeState} from './state';
import type {Activity} from './activity';
import {GuardianAvatar} from './GuardianAvatar';
import {GAME_NAMES} from './game-names';
import './outing.css';

const labels = {
    ko: {queued: '출발 대기', running: '놀러 간 중', paused: '확인 필요', stopped: '외출 중단', complete: '다녀왔어요'},
    en: {queued: 'Ready to leave', running: 'Out exploring', paused: 'Needs attention', stopped: 'Outing stopped', complete: 'Back from the arcade'},
};
export function OutingBoard({giwa, demo, ko, onOpen}: {giwa: ReturnType<typeof useGiwaTickets>; demo: ArcadeState; ko: boolean; onOpen: (a: Activity) => void}) {
    const [stopping, setStopping] = useState<OutingView | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const locale = ko ? 'ko' : 'en';
    if (!giwa.jobs.length) return null;
    async function refresh() {setRefreshing(true); try {await giwa.refreshOutings();} finally {setRefreshing(false);}}
    return <section className="arc-outings" aria-labelledby="outings-title">
        <div className="arc-section-title"><div><span className="arc-overline">03 / {ko ? '친구들의 모험첩' : 'AWAY JOURNAL'}</span><h2 id="outings-title">{ko ? '잘 놀고 돌아올게요' : 'Little adventures, waiting for you'}</h2><p>{ko ? '화면을 닫아도 계속해요 · 규칙 기반 시뮬레이션' : 'Continues after you close this page · Rule-based simulation'}</p></div><button className="arc-text-button" onClick={() => void refresh()} disabled={refreshing || giwa.busy}><RefreshCw size={16}/>{refreshing ? ko ? '확인 중…' : 'Checking…' : ko ? '새로고침' : 'Refresh'}</button></div>
        <div className="arc-outing-list">{giwa.jobs.map(job => {
            const member = demo.characters.find(c => c.id === job.characterId);
            const latest = [...job.results].reverse().map(r => demo.activities.find(a => a.id === r.id)).find(a => a?.status === 'complete');
            const active = ['queued', 'running', 'paused'].includes(job.status);
            const expired = job.expiresAt <= Date.now();
            return <article key={job.id} className="arc-outing" data-status={job.status}>
                <div className="arc-outing-friend">{member && <GuardianAvatar appearance={member.appearance} color={member.color} portrait/>}<div><strong>{job.profile.name}</strong><span>{job.choice === 'auto' ? ko ? '마음 가는 대로' : 'Agent’s choice' : GAME_NAMES[locale][job.choice]}</span></div><span className="arc-outing-status" role="status">{job.status === 'complete' ? <Check size={14}/> : job.status === 'paused' ? <Pause size={14}/> : <Compass size={14}/>} {labels[locale][job.status]}</span></div>
                <div className="arc-outing-progress"><span>{ko ? '사용한 용돈' : 'Spent'} <b>{job.spent} / {job.admissions} mUSDC</b></span><progress value={job.spent} max={job.admissions} aria-label={ko ? `${job.profile.name} 사용한 용돈` : `${job.profile.name} allowance spent`}/><small>{ko ? `놀이 ${job.results.length}회 완료 · ${job.admissions - job.spent} mUSDC 미사용` : `${job.results.length} visits completed · ${job.admissions - job.spent} mUSDC unused`}</small></div>
                {job.status === 'paused' && <p className="arc-outing-attention">{job.error === 'payment_unresolved' ? ko ? '결제 결과를 확인하고 있어요. 재개해도 같은 입장권부터 확인해요.' : 'The payment is unresolved. Resume checks the same admission first.' : expired ? ko ? '용돈 승인이 만료됐어요. 중단 후 새 외출을 준비해 주세요.' : 'Your allowance expired. Stop this outing, then prepare a new one.' : ko ? '진행을 멈췄어요. 연결을 확인한 뒤 이어갈 수 있어요.' : 'This outing paused. Check the connection, then resume.'}</p>}
                <div className="arc-outing-actions">{latest && <button className="arc-inline-link" onClick={() => onOpen(latest)}>{ko ? '최근 이야기 펼치기' : 'Read the latest story'}<ArrowUpRight size={17}/></button>}{job.status === 'paused' && <button className="arc-text-button" disabled={giwa.busy} onClick={() => void giwa.controlJob(job.id, 'resume')}>{ko ? '확인하고 이어가기' : 'Check and resume'}</button>}{active && <button className="arc-text-button" disabled={giwa.busy} onClick={() => setStopping(job)}>{ko ? '외출 중단' : 'Stop outing'}</button>}</div>
            </article>;
        })}</div>
        <ConfirmDialog open={!!stopping} onOpenChange={open => {if (!open) setStopping(null);}} title={ko ? '다음 입장부터 멈출까요?' : 'Stop before the next admission?'} confirm={ko ? '외출 중단' : 'Stop outing'} cancel={ko ? '계속 놀기' : 'Keep exploring'} onConfirm={() => {if (stopping) void giwa.controlJob(stopping.id, 'stop'); setStopping(null);}}><p>{ko ? '이미 요청한 결제는 결과를 확인하고 놀이를 마쳐요. 사용하지 않은 용돈은 내 계정에 남아요. 서명한 권한까지 회수하려면 용돈 메뉴에서 회수해 주세요.' : 'A requested payment is resolved and its game completed. Unspent funds stay in your account. To revoke the signed permission too, use the allowance controls.'}</p></ConfirmDialog>
    </section>;
}
