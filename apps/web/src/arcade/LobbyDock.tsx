import type {ReactNode} from "react";
import {Link} from "@tanstack/react-router";
import {ArrowRight, CircleAlert, Clock, Compass, Gamepad2, LoaderCircle, Pause, RefreshCw, Sparkles, Ticket, Trophy, Users} from "lucide-react";
import {GAME_NAMES, type GameId} from "@mapae/arcade";
import {ZODIAC_NAMES} from "@mapae/arcade/guardian-art";
import {guardianName, type GuardianZodiac} from "@mapae/arcade/guardians";
import {seasonPeriod} from "@mapae/arcade/season";
import {GuardianAvatar} from "./GuardianAvatar";
import {SignInCard} from "./SignInCard";
import {TEMPERAMENT_NAMES} from "./nft/model";
import type {DeskStage, GuardianDesk} from "./nft/useGuardianDesk";
import type {GuardianToken} from "./profile/guardians";
import {arcadeSectionLink, outingStatusLabel} from "./sections";
import {ConnectInvite, GuardianSwitcher} from "./sections/SectionFrame";
import {FaucetHint} from "./FaucetHint";
import {useTeamBoard} from "./ranking/client";
import {teamCheerCopy} from "./ranking/format";
import {RankLine} from "./ranking/RankLine";
import {SeasonMarks} from "./ranking/SeasonMark";

/** While the season runs or once it is over: where this guardian's zodiac team stands (or finished), as a line into the team tab. */
function TeamCheer({desk, zodiac}: {desk: GuardianDesk; zodiac: GuardianZodiac}) {
    const {locale, season: status} = desk, phase = status.value?.phase, racing = phase === "open" || phase === "closed";
    const teams = useTeamBoard(status.value ? seasonPeriod(status.value) : "week", racing);
    if (!racing || !teams.value || teams.value.entrants === 0) return null;
    const final = phase === "closed" ? desk.hall.value?.sealed ? "sealed" : "pending" : null;
    return <Link className="arc-text-button arc-dock-team" {...arcadeSectionLink("ranking", locale, "team")}><Users size={16} aria-hidden="true" />{teamCheerCopy(teams.value.rows, zodiac, locale, final)}</Link>;
}

/** What the lobby offers under the chosen cabinet, from a first free round to playing and sending out one's own guardian. */
export function LobbyDock({desk, game, walletWaiting, onPlayGuest, onPractice, onSendOuting}: {
    desk: GuardianDesk; game: GameId; walletWaiting: boolean; onPlayGuest: (game: GameId) => void;
    onPractice: (token: GuardianToken, game: GameId) => void; onSendOuting: (game: GameId) => void;
}) {
    const {ko, locale, stage, nft, token, member, traits, activeJob, revealed} = desk, names = GAME_NAMES[locale];
    const guardians = arcadeSectionLink("guardians", locale);
    if (stage === "ready" && token && member && traits) {
        const status = activeJob ? outingStatusLabel(activeJob.status, locale) : null, marks = desk.marksOf(token.tokenId);
        return <div className="arc-entry-dock arc-dock-ready">
            <div className="arc-dock-side">
                <div className="arc-dock-guardian">
                    <GuardianAvatar appearance={member.appearance} color={member.color} portrait marks={marks} />
                    <div>
                        <span className="arc-dock-label">{ko ? "함께할 전령" : "Your guardian"}</span>
                        <h2>{guardianName(token.tokenId, locale)}</h2>
                        <p>{ZODIAC_NAMES[locale][traits.zodiac]} · {TEMPERAMENT_NAMES[locale][traits.temperament]}{marks.length > 0 && <SeasonMarks marks={marks} locale={locale} />}</p>
                        <p className="arc-dock-aptitude"><span>{ko ? `${names[game]} 적성` : `${names[game]} aptitude`}</span><meter min={0} max={6} value={traits.aptitudes[game]} aria-hidden="true" /><b>{traits.aptitudes[game]} / 6</b></p>
                        <RankLine locale={locale} game={game} guardian={desk.ranking.standings?.guardians.find(g => g.tokenId === token.tokenId)} leader={desk.ranking.standings?.leaders[game] ?? null} named={false} weekly />
                        <TeamCheer desk={desk} zodiac={traits.zodiac} />
                        {activeJob && status && <span className="arc-dock-chip" role="status">{activeJob.status === "paused" ? <Pause size={14} aria-hidden="true" /> : <Compass size={14} aria-hidden="true" />}{ko ? `${status} · ${activeJob.spent}/${activeJob.admissions}회` : `${status} · ${activeJob.spent}/${activeJob.admissions} rounds`}</span>}
                    </div>
                </div>
                <GuardianSwitcher desk={desk} />
            </div>
            <div className="arc-dock-play">
                <div className="arc-dock-actions">
                    <button type="button" className="arc-button" onClick={() => onPractice(token, game)}><Gamepad2 size={18} aria-hidden="true" />{ko ? "내 전령과 연습" : "Practice with my guardian"}</button>
                    <button type="button" className="arc-button arc-button-paper" onClick={() => onSendOuting(game)}><Ticket size={18} aria-hidden="true" />{activeJob ? ko ? "외출 살펴보기" : "Check the outing" : ko ? "전령 외출 보내기" : "Send on an outing"}</button>
                </div>
                <small>{ko ? "연습은 무료예요 · NFT 경험치는 외출로만 쌓여요" : "Practice is free · NFT experience comes from outings"}</small>
                <Link className="arc-text-button arc-dock-free" {...arcadeSectionLink("ranking", locale)}><Trophy size={16} aria-hidden="true" />{ko ? "랭킹 보기" : "See the rankings"}</Link>
                <button type="button" className="arc-text-button arc-dock-free" onClick={() => onPlayGuest(game)}>{ko ? "체험 전령으로 무료 한 판" : "Free round with a trial guardian"}<ArrowRight size={16} aria-hidden="true" /></button>
            </div>
        </div>;
    }
    const guardian: Record<DeskStage, ReactNode> = {
        ready: null,
        guest: <><p>{ko ? "내 전령과 이어서 모험하려면" : "To continue with your own guardian"}</p>
            <ConnectInvite ko={ko} walletWaiting={walletWaiting} secondary /><FaucetHint locale={locale} compact /></>,
        pending: <p className="arc-dock-pending" role="status"><LoaderCircle size={18} className="arc-loading-icon" aria-hidden="true" />{ko ? "지갑과 전령단을 확인하고 있어요…" : "Checking your wallet and guardians…"}</p>,
        signin: desk.owner ? <SignInCard owner={desk.owner} session={desk.session} ko={ko} /> : null,
        unavailable: <div className="arc-notice nft-notice" role="alert"><CircleAlert size={16} aria-hidden="true" /><p>{nft.error}</p><button type="button" className="arc-text-button" disabled={nft.loading} onClick={() => void nft.refresh()}><RefreshCw size={16} aria-hidden="true" />{ko ? "다시 불러오기" : "Retry"}</button></div>,
        closed: <div className="arc-dock-next"><p>{ko ? "전령단이 곧 문을 열어요. 그동안 무료 게임을 즐겨 보세요." : "Guardians are on their way. Enjoy the free games meanwhile."}</p></div>,
        empty: <div className="arc-dock-next"><p>{ko ? "아직 함께할 전령이 없어요. 첫 전령을 뽑으면 이 게임기에서 같이 놀 수 있어요." : "No guardian yet. Draw your first and play this cabinet together."}</p><Link className="arc-button arc-button-paper" {...guardians}><Sparkles size={18} aria-hidden="true" />{ko ? "첫 전령 뽑기" : "Draw my first guardian"}</Link><FaucetHint locale={locale} /></div>,
        waiting: <div className="arc-dock-next"><p><Clock size={16} aria-hidden="true" />{ko ? "전령의 탄생을 기다리고 있어요." : "Your guardian is on the way."}</p><Link className="arc-button arc-button-paper" {...guardians}><Sparkles size={18} aria-hidden="true" />{ko ? "탄생 확인하러 가기" : "Check the reveal"}</Link>{revealed[0] && <button type="button" className="arc-text-button" onClick={() => void nft.select(revealed[0]!.tokenId)}>{ko ? "다른 전령과 놀기" : "Play with another guardian"}</button>}</div>,
    };
    return <div className="arc-entry-dock">
        <h2>{stage === "unavailable" ? ko ? "전령을 잠시 불러오지 못했어요" : "Your guardians did not load" : ko ? "먼저 한 판, 가볍게 놀아보세요" : "Try a round. Make yourself at home."}</h2>
        <p>{stage === "guest" ? ko ? "지갑 없이 직접 플레이하고, 마음에 들면 나의 전령을 만나보세요." : "Play without a wallet, then meet your own guardian." : ko ? "무료 체험은 언제든 할 수 있어요." : "A free round is always on the house."}</p>
        <div className="arc-entry-free"><button type="button" className="arc-button" onClick={() => onPlayGuest(game)}>{ko ? "무료로 한 판" : "Play a free round"}<ArrowRight size={19} aria-hidden="true" /></button><small>{ko ? "연습 기록은 이 탭에만 저장돼요" : "Practice records stay in this tab"}</small></div>
        <div className="arc-entry-guardian">{guardian[stage]}</div>
    </div>;
}
