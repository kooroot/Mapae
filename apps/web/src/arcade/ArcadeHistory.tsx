import {useState} from "react";
import {ArrowUpRight, Gamepad2, Stamp} from "lucide-react";
import {BrandSelect} from "../components/BrandSelect";
import type {Locale} from "../lib/i18n";
import type {ArcadeState} from "./state";
import type {Activity} from "./activity";
import {GuardianAvatar} from "./GuardianAvatar";
import {GAME_NAMES} from "./game-names";

export function ArcadeHistory({demo, locale, onOpen, onPractice, canPractice, busy}: {
    demo: ArcadeState; locale: Locale; onOpen: (activity: Activity) => void; onPractice: () => void; canPractice: boolean; busy: boolean;
}) {
    const ko = locale === "ko";
    const [characterId, setCharacterId] = useState("all");
    const history = characterId === "all" ? demo.activities : demo.activities.filter(a => a.characterId === characterId);
    return <section className="arc-postcards" id="arcade-history" aria-labelledby="history-title">
        <div className="arc-postcards-heading"><div><span className="arc-overline">03 / {ko ? "우리들의 모험첩" : "THE ADVENTURE JOURNAL"}</span><h2 id="history-title">{ko ? "놀다 온 이야기" : "Postcards from the arcade"}</h2></div><span className="arc-history-count"><Stamp size={16} />{ko ? `${demo.activities.length}개의 추억` : `${demo.activities.length} memories`}</span></div>
        {demo.activities.length > 0 && demo.characters.length > 1 && <label className="arc-history-filter">{ko ? "친구별로 보기" : "View by character"}<BrandSelect value={characterId} onValueChange={setCharacterId} options={[{value: "all", label: ko ? "모든 친구" : "Everyone"}, ...demo.characters.map(c => ({value: c.id, label: c.name}))]} /></label>}
        {history.length === 0 ? <div className="arc-postcard-empty"><div className="arc-postcard-illustration" aria-hidden="true"><span>MAPAE<br />ARCADE</span><img src="/arcade/guardians/tiger-256.webp" width={256} height={256} alt="" loading="lazy" /><i>✦</i></div><div><h3>{ko ? "아직 외출 기록이 없어요" : "No outings yet"}</h3><p>{characterId !== "all" ? ko ? "이 친구의 외출을 기다리고 있어요." : "This friend has not headed out yet." : ko ? "놀이를 마치면 점수와 사용한 용돈을 여기서 확인해요." : "Find scores and spending here after an outing."}</p><a href={demo.characters.length ? "#arcade-allowance" : "#arcade-crew"} className="arc-inline-link">{demo.characters.length ? ko ? "첫 외출 준비하기" : "Prepare the first outing" : ko ? "첫 친구 만들러 가기" : "Meet your first friend"}<ArrowUpRight size={18} /></a></div></div>
        : <ol className="arc-postcard-list">{history.slice(0, 12).map(a => <li key={a.id}><button className="arc-postcard" disabled={busy} onClick={() => onOpen(a)}>
            <GuardianAvatar appearance={a.appearance} color={a.color} />
            <div><span className="arc-postcard-game">{GAME_NAMES[locale][a.game]} · {new Intl.DateTimeFormat(ko ? "ko-KR" : "en", {month: "short", day: "numeric"}).format(a.at)}</span><h3>{ko ? `${a.name}의 하루` : `${a.name}'s adventure`}</h3><p>{a.outcome?.summary[locale] ?? (ko ? "마치지 않은 외출 · 입장 기록 보기" : "Unfinished outing · view admission")}</p><small>{a.source === "practice" ? ko ? "직접 연습 · 무료" : "Human practice · Free" : a.mode === "llm" ? a.model ?? "LLM" : ko ? "규칙 기반 봇" : "Rule bot"}{a.source === "mapae-giwa" ? " · GIWA" : ""}</small></div><span className="arc-postcard-score">{a.outcome ? <><b>{a.outcome.score.toLocaleString()}</b><small>{ko ? "점" : "PTS"}</small></> : <Stamp size={24} />}<ArrowUpRight size={17} /></span>
        </button></li>)}</ol>}
        <div className="arc-journal-bottom"><button className="arc-practice-link" disabled={!canPractice} onClick={onPractice}><Gamepad2 size={19} /><span>{ko ? "내가 직접 플레이" : "Play it yourself"}<small>{demo.characters.length > 0 ? ko ? "입장권 없이 무료 연습" : "Free practice · no ticket needed" : ko ? "캐릭터를 만들면 연습할 수 있어요" : "Create a character to practice"}</small></span><ArrowUpRight size={18} /></button></div>
    </section>;
}
