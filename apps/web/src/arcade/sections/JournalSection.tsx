import {useId, useState} from 'react';
import {Check, LoaderCircle, ReceiptText, RefreshCw, Stamp} from 'lucide-react';
import {GUARDIAN_CLAIM_BATCH} from '@mapae/arcade/guardians';
import {kstDay} from '@mapae/arcade/ranking';
import {explorerTxUrl} from '../../lib/config';
import type {Locale} from '../../lib/i18n';
import {GameThumb} from '../Characters';
import {GAME_NAMES} from '../game-names';
import {GuardianAvatar} from '../GuardianAvatar';
import {pendingGrowth, pendingHonors} from '../nft/model';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import type {GuardianToken, VerifiedResult} from '../profile/guardians';
import {ShareActions} from '../share/ShareButton';
import type {GuardianStanding} from '@mapae/arcade/ranking';
import {DeskGate, GuardianSwitcher, NftStatus, SectionHeading} from './SectionFrame';

/** Journal: the chosen guardian's growth on the NFT, the verified adventures still waiting, and one transaction to record them. */
export function JournalSection({desk, walletWaiting}: {desk: GuardianDesk; walletWaiting: boolean}) {
    return <div className="nft-arcade">
        <SectionHeading section="journal" desk={desk}><GuardianSwitcher desk={desk} /></SectionHeading>
        <DeskGate desk={desk} walletWaiting={walletWaiting} need="guardian"><NftStatus desk={desk} phase={false} /><Journal desk={desk} /></DeskGate>
    </div>;
}

type Recorded = {tokenId: string; level: number; experience: number; honorWeek: number};

function Journal({desk}: {desk: GuardianDesk}) {
    const {ko, locale, giwa, nft, token, member, ranking} = desk;
    const [view, setView] = useState<'waiting' | 'all' | null>(null), [recorded, setRecorded] = useState<Recorded | null>(null);
    if (!token || !member) return null;
    const detail = nft.detail?.guardian.tokenId === token.tokenId ? nft.detail : null;
    const onChain = token.progress, pending = detail ? pendingGrowth(onChain, detail.earned) : null;
    const honor = pendingHonors(token.honors, detail?.honors ?? null);
    const total = Math.max(onChain.experience, detail?.earned.experience ?? 0);
    const shown = view ?? (pending?.plays ? 'waiting' : 'all');
    const rows = detail ? shown === 'waiting' ? detail.results.filter(r => !r.claimed) : detail.results : [];
    // An attached honor takes one place in the contract batch.
    const batch = Math.min(pending?.plays ?? 0, GUARDIAN_CLAIM_BATCH - (honor.any ? 1 : 0));
    const levelAfter = detail ? 1 + Math.floor(detail.earned.experience / 100) : onChain.level;
    const standing = ranking.standings?.guardians.find(g => g.tokenId === token.tokenId) ?? null, standingsDay = ranking.standings?.day ?? null;
    const celebrate = recorded?.tokenId === token.tokenId && !nft.busy && (onChain.experience > recorded.experience || token.honors.week > recorded.honorWeek) ? recorded : null;
    const waitingHonors = [honor.titles > 0 && (ko ? `칭호 ${honor.titles}개` : `${honor.titles} ${honor.titles === 1 ? 'title' : 'titles'}`),
        honor.longestStreak !== null && (ko ? `최장 출석 ${honor.longestStreak}일` : `${honor.longestStreak}-day best streak`)].filter(Boolean).join(' · ');
    function record() {
        setRecorded({tokenId: token!.tokenId, level: onChain.level, experience: onChain.experience, honorWeek: token!.honors.week});
        void nft.claimAll();
    }
    return <section className="nft-growth jr" aria-labelledby="nft-growth-title">
        <header className="jr-summary">
            <GuardianAvatar appearance={member.appearance} color={member.color} portrait />
            <div className="jr-who">
                <h2 id="nft-growth-title">{member.name}</h2>
                <p>{ko ? `NFT 레벨 ${onChain.level} · 승리 ${onChain.victories}` : `NFT level ${onChain.level} · ${onChain.victories} victories`}{honorLine(token, ko)}</p>
            </div>
            <div className="jr-xp">
                <XpBar recorded={onChain.experience} waiting={pending?.experience ?? 0} total={total} label={ko ? `NFT ${onChain.experience} XP, 기록 대기 ${pending?.experience ?? 0} XP` : `${onChain.experience} XP on NFT, ${pending?.experience ?? 0} XP waiting`} />
                <p className="jr-xp-legend"><span className="is-onchain">{ko ? 'NFT' : 'On NFT'} <b>{onChain.experience} XP</b></span>
                    {pending ? <>{pending.experience > 0 && <span className="is-waiting">{ko ? '기록 대기' : 'Waiting'} <b>+{pending.experience} XP</b></span>}<span>{ko ? `${detail!.earned.plays}회 모험` : `${detail!.earned.plays} outings`}</span>
                        {waitingHonors && <span>{ko ? <><b>{waitingHonors}</b> 기록 대기</> : <><b>{waitingHonors}</b> waiting</>}</span>}</>
                        : nft.error && !nft.loading ? <span>{ko ? '검증된 모험을 불러오지 못했어요' : 'Verified outings unavailable'}</span>
                        : <span role="status">{ko ? '검증된 모험을 불러오는 중…' : 'Loading verified outings…'}</span>}</p>
            </div>
            <div className="jr-action">
                {celebrate ? <p className="jr-stamp" role="status"><Stamp size={22} aria-hidden="true" /><span><b>{stampTitle(onChain.experience - celebrate.experience, token.honors.week > celebrate.honorWeek, ko)}</b>{onChain.level > celebrate.level && <>{ko ? `레벨 ${celebrate.level} → ${onChain.level}` : `Level ${celebrate.level} → ${onChain.level}`}</>}</span></p> : null}
                {nft.busy ? <p className="jr-progress" role="status"><LoaderCircle size={18} className="arc-loading-icon" aria-hidden="true" />{nft.phase}</p>
                    : pending?.plays || (pending && honor.any) ? <>
                        <button type="button" className="arc-button" disabled={giwa.busy || !!nft.transaction} onClick={record}>{recordLabel(batch, honor.any, ko)}</button>
                        <small>{pending.plays > batch
                            ? ko ? `한 번에 ${GUARDIAN_CLAIM_BATCH}건까지 기록해요. 남은 ${pending.plays - batch}건은 다음 기록에서 이어져요.` : `Up to ${GUARDIAN_CLAIM_BATCH} per transaction; the other ${pending.plays - batch} follow in the next one.`
                            : !batch ? ko ? '지갑 서명 한 번 · 테스트 ETH 수수료 1회' : 'One wallet signature · one test-ETH fee'
                            : ko ? `지갑 서명 한 번 · 테스트 ETH 수수료 1회 · 기록하면 레벨 ${levelAfter}` : `One wallet signature · one test-ETH fee · level ${levelAfter} once recorded`}</small>
                    </>
                    : pending && !celebrate ? <p className="jr-done"><Check size={18} aria-hidden="true" />{ko ? '모든 모험이 NFT에 기록됐어요' : 'Every outing is on the NFT'}</p>
                    : !pending && nft.error && !nft.loading ? <button type="button" className="arc-text-button" onClick={() => void nft.refresh()}><RefreshCw size={16} aria-hidden="true" />{ko ? '다시 불러오기' : 'Retry'}</button> : null}
            </div>
        </header>
        {detail && detail.results.length > 0 && <div className="jr-filter" role="group" aria-label={ko ? '모험 보기' : 'Show outings'}>
            <button type="button" aria-pressed={shown === 'waiting'} onClick={() => setView('waiting')}>{ko ? '기록 대기' : 'Waiting'} <b>{pending?.plays ?? 0}</b></button>
            <button type="button" aria-pressed={shown === 'all'} onClick={() => setView('all')}>{ko ? '전체' : 'All'} <b>{detail.earned.plays}</b></button>
        </div>}
        {detail?.results.length === 0 && <p className="jr-empty">{ko ? '첫 외출을 보내면 이곳에 모험이 쌓여요.' : 'Send your first outing and adventures will gather here.'}</p>}
        {detail && rows.length === 0 && detail.results.length > 0 && <p className="jr-empty">{shown === 'waiting' && pending?.plays ? (ko ? '불러온 모험은 모두 기록됐어요. 이전 모험을 더 불러와 보세요.' : 'Every loaded outing is recorded. Load earlier ones below.') : (ko ? '기록을 기다리는 모험이 없어요.' : 'Nothing is waiting to be recorded.')}</p>}
        {groupByDay(rows, locale, desk.now).map(day => <section key={day.key} className="jr-day" aria-label={day.label}>
            <h3><span>{day.label}</span><small>+{day.experience} XP</small></h3>
            <ol>{day.rows.map(r => <JournalRow key={r.id} result={r} locale={locale} standing={standing} standingsDay={standingsDay} />)}</ol>
        </section>)}
        {detail?.nextCursor && <button type="button" className="arc-button arc-button-paper nft-more" onClick={() => void nft.more()}>{ko ? '이전 모험 더 보기' : 'More adventures'}</button>}
        <p className="nft-small">{ko ? '검증된 모험은 기록 전에도 사라지지 않아요. 기록이 실패하면 같은 모험을 다시 기록하며, 입장권을 새로 사지 않아요.' : 'Verified outings stay safe until recorded. If recording fails, the same outings are retried; no new admission is purchased.'}</p>
    </section>;
}

/** The record button: outings alone, outings and honors together, or honors alone; always one transaction. */
function recordLabel(batch: number, honors: boolean, ko: boolean): string {
    if (!honors) return ko ? `NFT에 한 번에 기록 (${batch}건)` : `Record ${batch} on NFT at once`;
    if (!batch) return ko ? 'NFT에 칭호·출석 기록' : 'Record honors on NFT';
    return ko ? `NFT에 한 번에 기록 (모험 ${batch}건 + 칭호·출석)` : `Record ${batch} + honors on NFT at once`;
}
function stampTitle(experience: number, honors: boolean, ko: boolean): string {
    const parts = [experience > 0 && `+${experience} XP`, honors && (ko ? '칭호·출석' : 'honors')].filter(Boolean);
    return ko ? `NFT에 ${parts.join(' · ')} 기록` : `${parts.join(' and ')} recorded`;
}
/** The honors the NFT itself carries, after the level line; nothing until the first honor claim. */
function honorLine(token: GuardianToken, ko: boolean): string {
    const titles = token.honors.titles.reduce((n, t) => n + t.champion + t.podium + t.top10, 0), streak = token.honors.longestStreak;
    return [titles > 0 && (ko ? ` · 칭호 ${titles}` : ` · ${titles} ${titles === 1 ? 'title' : 'titles'}`),
        streak > 0 && (ko ? ` · 최장 출석 ${streak}일` : ` · ${streak}-day best streak`)].filter(Boolean).join('');
}

/** A ranked row shares its day's standing only while the boards still show that very score, so the post and the card agree with the row. */
function JournalRow({result: r, locale, standing, standingsDay}: {result: VerifiedResult; locale: Locale; standing: GuardianStanding | null; standingsDay: string | null}) {
    const ko = locale === 'ko', xp = r.victory ? 15 : 10;
    const today = r.ranked && standing && r.ranked.day === standingsDay ? standing.games[r.game].today : null, shared = today && today.score === r.score ? today : null;
    return <li className={`jr-row${r.claimed ? ' is-claimed' : ''}`}>
        <GameThumb game={r.game} />
        <div className="jr-row-main">
            <strong>{GAME_NAMES[locale][r.game]}</strong>
            <span>{r.outcome.summary[locale]}</span>
        </div>
        <span className="jr-score">{r.score.toLocaleString(locale)}{ko ? '점' : ' pts'}</span>
        <span className={`jr-xp-pill${r.victory ? ' is-victory' : ''}`} title={r.victory ? (ko ? '목표 달성' : 'Achievement') : (ko ? '모험 완료' : 'Completed')}>+{xp} XP</span>
        <span className="jr-meta">
            <time dateTime={new Date(r.at).toISOString()}>{TIME[locale].format(r.at)}</time>
            {r.ranked && <span className="jr-ranked" title={ko ? '순위에 들어간 판' : 'Counted on the boards'}><i aria-hidden="true" />{ko ? '랭크' : 'Ranked'}</span>}
            {shared && r.ranked && <ShareActions target={{kind: 'run', tokenId: standing!.tokenId, game: r.game, day: r.ranked.day}} standing={shared} locale={locale} compact />}
            {r.claimed && <span className="jr-claimed"><Check size={13} aria-hidden="true" />{ko ? '기록됨' : 'Recorded'}</span>}
        </span>
        {r.transaction ? <a className="jr-receipt" href={explorerTxUrl(r.transaction)} target="_blank" rel="noreferrer" aria-label={ko ? '입장 결제 영수증 (새 창)' : 'Admission receipt (new tab)'} title={ko ? '입장 결제 영수증' : 'Admission receipt'}><ReceiptText size={18} aria-hidden="true" /></a> : <span className="jr-receipt" aria-hidden="true" />}
    </li>;
}

/** Recorded XP solid, waiting XP striped; drawn in SVG so the page needs no inline style. */
function XpBar({recorded, waiting, total, label}: {recorded: number; waiting: number; total: number; label: string}) {
    const id = useId(), a = total ? recorded / total * 100 : 0, b = total ? waiting / total * 100 : 0;
    return <svg className="jr-xp-bar" viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label={label}>
        <defs><pattern id={id} width="6" height="12" patternUnits="userSpaceOnUse" patternTransform="skewX(-35)"><rect width="6" height="12" fill="#e2b24a33" /><rect width="3" height="12" fill="#e2b24a99" /></pattern></defs>
        <rect width="100" height="12" fill="#e9dfcb" /><rect width={a} height="12" fill="#e2b24a" /><rect x={a} width={b} height="12" fill={`url(#${id})`} />
    </svg>;
}

const TIME = {
    ko: new Intl.DateTimeFormat('ko-KR', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Seoul'}),
    en: new Intl.DateTimeFormat('en-US', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Seoul'}),
} as const;
const DAY = {
    ko: new Intl.DateTimeFormat('ko-KR', {month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul'}),
    en: new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul'}),
} as const;

/** Rows grouped by Korean-time day, the clock the boards and ranked rounds run on. */
export function groupByDay(rows: readonly VerifiedResult[], locale: Locale, now: number) {
    const today = kstDay(now), yesterday = kstDay(now - 86_400_000), days: {key: string; label: string; experience: number; rows: VerifiedResult[]}[] = [];
    for (const r of rows) {
        const key = kstDay(r.at);
        let day = days.at(-1);
        if (day?.key !== key) {
            day = {key, label: key === today ? (locale === 'ko' ? '오늘' : 'Today') : key === yesterday ? (locale === 'ko' ? '어제' : 'Yesterday') : DAY[locale].format(r.at), experience: 0, rows: []};
            days.push(day);
        }
        day.rows.push(r); day.experience += r.victory ? 15 : 10;
    }
    return days;
}
