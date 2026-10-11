import type {ReactNode} from "react";
import {ArrowRight, CircleAlert, Clock, Compass, Gamepad2, LoaderCircle, Pause, RefreshCw, Sparkles, Ticket} from "lucide-react";
import type {GameId} from "@mapae/arcade";
import {guardianName} from "@mapae/arcade/guardians";
import {WalletPicker} from "../components/WalletPicker";
import {GAME_NAMES} from "./game-names";
import {GUARDIAN_NAMES} from "./guardian";
import {GuardianAvatar} from "./GuardianAvatar";
import {SignInCard} from "./SignInCard";
import {TEMPERAMENT_NAMES} from "./nft/model";
import type {DeskStage, GuardianDesk} from "./nft/useGuardianDesk";
import type {GuardianToken} from "./profile/guardians";

const OUTING_STATUS = {
    ko: {queued: "출발 대기", running: "외출 중", paused: "확인 필요"},
    en: {queued: "Ready to leave", running: "Out exploring", paused: "Needs attention"},
};

/** What the lobby offers under the chosen cabinet, from a first free round to playing and sending out one's own guardian. */
export function LobbyDock({desk, game, walletWaiting, onPlayGuest, onPractice, onSendOuting, onOpenGuardians}: {
    desk: GuardianDesk; game: GameId; walletWaiting: boolean; onPlayGuest: (game: GameId) => void;
    onPractice: (token: GuardianToken, game: GameId) => void; onSendOuting: (game: GameId) => void; onOpenGuardians: () => void;
}) {
    const {ko, locale, stage, nft, token, member, traits, activeJob, revealed, crew} = desk, names = GAME_NAMES[locale];
    if (stage === "ready" && token && member && traits) {
        const status = activeJob && activeJob.status in OUTING_STATUS[locale] ? OUTING_STATUS[locale][activeJob.status as keyof typeof OUTING_STATUS.ko] : null;
        return <div className="arc-entry-dock arc-dock-ready">
            <div className="arc-dock-guardian">
                <GuardianAvatar appearance={member.appearance} color={member.color} portrait />
                <div>
                    <span className="arc-dock-label">{ko ? "함께할 전령" : "Your guardian"}</span>
                    <h2>{guardianName(token.tokenId, locale)}</h2>
                    <p>{GUARDIAN_NAMES[locale][traits.zodiac]} · {TEMPERAMENT_NAMES[locale][traits.temperament]}</p>
                    <p className="arc-dock-aptitude"><span>{ko ? `${names[game]} 적성` : `${names[game]} aptitude`}</span><meter min={0} max={6} value={traits.aptitudes[game]} aria-hidden="true" /><b>{traits.aptitudes[game]} / 6</b></p>
                    {activeJob && status && <span className="arc-dock-chip" role="status">{activeJob.status === "paused" ? <Pause size={14} aria-hidden="true" /> : <Compass size={14} aria-hidden="true" />}{ko ? `${status} · ${activeJob.spent}/${activeJob.admissions}회` : `${status} · ${activeJob.spent}/${activeJob.admissions} rounds`}</span>}
                </div>
            </div>
            {revealed.length > 1 && <div className="arc-dock-switcher" role="group" aria-label={ko ? "함께할 전령 바꾸기" : "Switch guardian"}>
                {revealed.map((t, index) => <button key={t.tokenId} type="button" aria-pressed={t.tokenId === token.tokenId} aria-label={guardianName(t.tokenId, locale)} title={guardianName(t.tokenId, locale)} onClick={() => void nft.select(t.tokenId)}><GuardianAvatar appearance={crew[index]?.appearance} color={crew[index]?.color} portrait /></button>)}
            </div>}
            <div className="arc-dock-actions">
                <button type="button" className="arc-button" onClick={() => onPractice(token, game)}><Gamepad2 size={18} aria-hidden="true" />{ko ? "내 전령과 연습" : "Practice with my guardian"}</button>
                <button type="button" className="arc-button arc-button-paper" onClick={() => onSendOuting(game)}><Ticket size={18} aria-hidden="true" />{activeJob ? ko ? "외출 살펴보기" : "Check the outing" : ko ? "전령 외출 보내기" : "Send on an outing"}</button>
            </div>
            <small>{ko ? "연습은 무료예요 · NFT 경험치는 외출로만 쌓여요" : "Practice is free · NFT experience comes from outings"}</small>
            <button type="button" className="arc-text-button arc-dock-free" onClick={() => onPlayGuest(game)}>{ko ? "체험 전령으로 무료 한 판" : "Free round with a trial guardian"}<ArrowRight size={16} aria-hidden="true" /></button>
        </div>;
    }
    const guardian: Record<DeskStage, ReactNode> = {
        ready: null,
        guest: <><p>{ko ? "내 전령과 이어서 모험하려면" : "To continue with your own guardian"}</p>
            <ol className="arc-entry-steps"><li><Sparkles size={17} aria-hidden="true" />{ko ? "나만의 전령" : "Your own guardian"}</li><li><Ticket size={17} aria-hidden="true" />{ko ? "한도 있는 용돈" : "A bounded allowance"}</li><li><Gamepad2 size={17} aria-hidden="true" />{ko ? "작은 모험 시작" : "A little adventure"}</li></ol>
            <WalletPicker reconnecting={walletWaiting} />
            <small>{ko ? "같은 지갑으로 로그인하면 전령과 기록이 이어져요" : "Sign in with the same wallet to continue with your guardians and records"}</small></>,
        pending: <p className="arc-dock-pending" role="status"><LoaderCircle size={18} className="arc-loading-icon" aria-hidden="true" />{ko ? "지갑과 전령단을 확인하고 있어요…" : "Checking your wallet and guardians…"}</p>,
        signin: desk.owner ? <SignInCard owner={desk.owner} session={desk.session} ko={ko} /> : null,
        unavailable: <div className="arc-notice nft-notice" role="alert"><CircleAlert size={16} aria-hidden="true" /><p>{nft.error}</p><button type="button" className="arc-text-button" disabled={nft.loading} onClick={() => void nft.refresh()}><RefreshCw size={16} aria-hidden="true" />{ko ? "다시 불러오기" : "Retry"}</button></div>,
        closed: <div className="arc-dock-next"><p>{ko ? "전령단이 곧 문을 열어요. 그동안 무료 게임을 즐겨 보세요." : "Guardians are on their way. Enjoy the free games meanwhile."}</p></div>,
        empty: <div className="arc-dock-next"><p>{ko ? "아직 함께할 전령이 없어요. 첫 전령을 뽑으면 이 게임기에서 같이 놀 수 있어요." : "No guardian yet. Draw your first and play this cabinet together."}</p><button type="button" className="arc-button arc-button-paper" onClick={onOpenGuardians}><Sparkles size={18} aria-hidden="true" />{ko ? "첫 전령 뽑기" : "Draw my first guardian"}</button></div>,
        waiting: <div className="arc-dock-next"><p><Clock size={16} aria-hidden="true" />{ko ? "전령의 탄생을 기다리고 있어요." : "Your guardian is on the way."}</p><button type="button" className="arc-button arc-button-paper" onClick={onOpenGuardians}><Sparkles size={18} aria-hidden="true" />{ko ? "탄생 확인하러 가기" : "Check the reveal"}</button>{revealed[0] && <button type="button" className="arc-text-button" onClick={() => void nft.select(revealed[0]!.tokenId)}>{ko ? "다른 전령과 놀기" : "Play with another guardian"}</button>}</div>,
    };
    return <div className="arc-entry-dock">
        <h2>{ko ? "먼저 한 판, 가볍게 놀아보세요" : "Try a round. Make yourself at home."}</h2>
        <p>{stage === "guest" ? ko ? "지갑 없이 직접 플레이하고, 마음에 들면 나의 전령을 만나보세요." : "Play without a wallet, then meet your own guardian." : ko ? "무료 체험은 언제든 할 수 있어요." : "A free round is always on the house."}</p>
        <div className="arc-entry-free"><button type="button" className="arc-button" onClick={() => onPlayGuest(game)}>{ko ? "무료로 한 판" : "Play a free round"}<ArrowRight size={19} aria-hidden="true" /></button><small>{ko ? "연습 기록은 이 탭에만 저장돼요" : "Practice records stay in this tab"}</small></div>
        <div className="arc-entry-guardian">{guardian[stage]}</div>
    </div>;
}
