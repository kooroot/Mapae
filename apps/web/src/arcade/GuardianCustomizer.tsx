import {useState} from "react";
import {Dices, Lock, Unlock, Download, FileJson} from "lucide-react";
import type {AgentGoal} from "@mapae/arcade";
import {BrandSelect} from "../components/BrandSelect";
import type {Companion, Color, Temperament} from "./state";
import {GuardianAvatar} from "./GuardianAvatar";
import {ZODIACS, BACKDROPS, CHARMS, GUARDIAN_NAMES, GUARDIAN_STORIES, guardianAsset, guardianSeed, rollGuardian, guardianMetadata, ROLL_FIELDS, type RollLock} from "./guardian";
import {WardrobePicker} from "./WardrobePicker";
import {wardrobeName} from "./wardrobe";
import {guardianImage} from "./guardian-export";

export function GuardianCustomizer({draft, onChange, ko}: {draft: Companion; onChange: (value: Companion) => void; ko: boolean}) {
    const [locks, setLocks] = useState<Set<RollLock>>(new Set());
    const [panel, setPanel] = useState<"zodiac" | "wardrobe" | "traits">("zodiac");
    const [style, setStyle] = useState<"matched" | "mix">("matched");
    const [rolled, setRolled] = useState(0);
    const [exporting, setExporting] = useState(false);
    const [notice, setNotice] = useState("");
    const [artifact, setArtifact] = useState<{key: string; href: string; kind: "png" | "json"; filename: string} | null>(null);
    const exportKey = JSON.stringify([draft.name, draft.appearance, draft.color, draft.temperament, draft.agent.goal]);
    const g = draft.appearance;
    const locale = ko ? "ko" : "en";
    function lock(key: RollLock, label: string) {
        return <button className="guardian-lock" type="button" disabled={!g || (["hat", "outfit", "shoes"].includes(key) && !g.wardrobe)} aria-label={`${label} ${ko ? "고정" : "lock"}`} aria-pressed={locks.has(key)} onClick={() => setLocks(previous => {
            const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
        })}>{locks.has(key) ? <Lock size={13} /> : <Unlock size={13} />}<span>{locks.has(key) ? ko ? "고정됨" : "Locked" : ko ? "고정" : "Lock"}</span></button>;
    }
    async function exportFile(kind: "png" | "json") {
        setExporting(true); setNotice("");
        try {
            const member = {...draft, name: draft.name.trim()};
            const href = kind === "png" ? await guardianImage(member) : `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(guardianMetadata(member), null, 2))}`;
            setArtifact({key: exportKey, href, kind, filename: `mapae-guardian-${member.id}.${kind}`});
            setNotice(ko ? "캐릭터 파일을 준비했어요." : "Your character file is ready.");
        } catch {setNotice(ko ? "파일을 만들지 못했어요. 다시 눌러 주세요." : "Could not prepare the file. Please try again.");}
        finally {setExporting(false);}
    }
    return <div className="guardian-workshop">
        <div className="guardian-preview"><GuardianAvatar appearance={g} color={draft.color} portrait /><div className="guardian-preview-copy"><strong>{g ? GUARDIAN_NAMES[locale][g.zodiac] : ko ? "나의 수호신" : "Your guardian"}</strong><p>{g ? GUARDIAN_STORIES[g.zodiac][locale] : ko ? "주사위를 굴려 새로운 모습을 만나보세요." : "Roll the dice to meet your guardian."}</p>{g && <><em className="guardian-costume-name">{wardrobeName(g.wardrobe, locale)}</em></>}</div></div>
        <div className="guardian-roll-style" role="group" aria-label={ko ? "주사위 방식" : "Dice style"}><button type="button" aria-pressed={style === "matched"} onClick={() => setStyle("matched")}>{ko ? "어울리는 한 벌" : "Matched outfit"}</button><button type="button" aria-pressed={style === "mix"} onClick={() => setStyle("mix")}>{ko ? "마구 섞기" : "Mix everything"}</button></div>
        <div className="guardian-roll-row"><button type="button" className="guardian-roll" disabled={locks.size === ROLL_FIELDS.length} onClick={() => {onChange(rollGuardian(draft, guardianSeed(), locks, style)); setRolled(n => n + 1);}}><Dices size={21} />{ko ? "주사위로 새 조합" : "Roll a new look"}</button><p>{ko ? "마음에 드는 항목은 잠그고 굴려요." : "Lock what you love, then roll the rest."}</p></div>
        <span className="guardian-sr" role="status">{rolled > 0 ? ko ? `${rolled}번째 조합. ${g ? GUARDIAN_NAMES.ko[g.zodiac] : ""}` : `Roll ${rolled}. ${g ? GUARDIAN_NAMES.en[g.zodiac] : ""}` : ""}</span>
        <details className="guardian-customize-details"><summary>{ko ? "세부 꾸미기 · 동물, 옷, 성향" : "Customize · Animal, clothes & traits"}</summary>
        <div className="guardian-panels" role="group" aria-label={ko ? "꾸미기 메뉴" : "Customize"}>{(["zodiac", "wardrobe", "traits"] as const).map((key, i) => <button key={key} type="button" aria-pressed={panel === key} onClick={() => setPanel(key)}>{(ko ? ["수호신 12", "조선 옷장", "성향 · 소품"] : ["Guardians", "Wardrobe", "Traits & charms"])[i]}</button>)}</div>
        {panel === "zodiac" && <div className="guardian-field"><div className="guardian-field-label"><strong>{ko ? "십이지신" : "Guardian"}</strong>{lock("zodiac", ko ? "십이지신" : "Guardian")}</div><div className="guardian-zodiacs" role="group" aria-label={ko ? "십이지신 선택" : "Choose a zodiac"}>{ZODIACS.map(zodiac => <button type="button" key={zodiac} aria-label={GUARDIAN_NAMES[locale][zodiac]} aria-pressed={g?.zodiac === zodiac} onClick={() => {
            const next = g ? draft : rollGuardian(draft, guardianSeed()); onChange({...next, appearance: {...next.appearance!, zodiac}});
        }}><img src={guardianAsset(zodiac, 256)} width={64} height={64} alt="" loading="lazy" /><span>{GUARDIAN_NAMES[locale][zodiac]}</span></button>)}</div></div>}
        {panel === "wardrobe" && <WardrobePicker value={g?.wardrobe} ko={ko} lock={lock} onChange={wardrobe => {if (!wardrobe) setLocks(previous => new Set([...previous].filter(key => key !== "hat" && key !== "outfit" && key !== "shoes"))); const next = g ? draft : rollGuardian(draft, guardianSeed()); onChange({...next, appearance: {...next.appearance!, wardrobe}});}} />}
        {panel === "traits" && g && <div className="guardian-fields">
            <div className="guardian-field"><div className="guardian-field-label"><strong>{ko ? "배경" : "Backdrop"}</strong>{lock("backdrop", ko ? "배경" : "Backdrop")}</div><BrandSelect label={ko ? "배경" : "Backdrop"} value={g.backdrop} onValueChange={backdrop => onChange({...draft, appearance: {...g, backdrop}})} options={BACKDROPS.map((value, i) => ({value, label: (ko ? ["새벽빛", "달밤", "비취 숲", "노을"] : ["Dawn", "Moonlight", "Jade grove", "Sunset"])[i]!}))} /></div>
            <div className="guardian-field"><div className="guardian-field-label"><strong>{ko ? "소지품" : "Charm"}</strong>{lock("charm", ko ? "소지품" : "Charm")}</div><BrandSelect label={ko ? "소지품" : "Charm"} value={g.charm} onValueChange={charm => onChange({...draft, appearance: {...g, charm}})} options={CHARMS.map((value, i) => ({value, label: (ko ? ["마패", "두루마리", "복주머니", "가벼운 손"] : ["Mapae pass", "Scroll", "Lucky pouch", "No charm"])[i]!}))} /></div>
            <div className="guardian-field"><div className="guardian-field-label"><strong>{ko ? "인장 색" : "Seal color"}</strong>{lock("color", ko ? "인장 색" : "Seal color")}</div><BrandSelect<Color> label={ko ? "인장 색" : "Seal color"} value={draft.color} onValueChange={color => onChange({...draft, color})} options={[{value: "red", label: ko ? "주홍" : "Vermilion"}, {value: "jade", label: ko ? "비취" : "Jade"}, {value: "ink", label: ko ? "먹색" : "Ink"}]} /></div>
            <div className="guardian-field"><div className="guardian-field-label"><strong>{ko ? "성향" : "Personality"}</strong>{lock("temperament", ko ? "성향" : "Personality")}</div><BrandSelect<Temperament> label={ko ? "성향" : "Personality"} value={draft.temperament} onValueChange={temperament => onChange({...draft, temperament})} options={[{value: "curious", label: ko ? "호기심" : "Curious"}, {value: "bold", label: ko ? "과감함" : "Bold"}, {value: "calm", label: ko ? "신중함" : "Calm"}]} /></div>
            <div className="guardian-field guardian-goal"><div className="guardian-field-label"><strong>{ko ? "오늘의 목표" : "Today's goal"}</strong>{lock("goal", ko ? "목표" : "Goal")}</div><BrandSelect<AgentGoal> label={ko ? "오늘의 목표" : "Today's goal"} value={draft.agent.goal} onValueChange={goal => onChange({...draft, agent: {...draft.agent, goal}})} options={[{value: "explore", label: ko ? "다양하게 경험하기" : "Explore"}, {value: "score", label: ko ? "좋은 기록 만들기" : "Chase a score"}, {value: "save", label: ko ? "알뜰한 구매 배우기" : "Shop thoughtfully"}]} /></div>
        </div>}
        <p className="guardian-trait-note">{ko ? "꾸미기는 능력치에 영향을 주지 않아요. 성향과 목표는 놀이 전략에 반영돼요." : "Looks are cosmetic. Personality and goals guide play strategy."}</p>
        </details>
        <details className="guardian-export"><summary>{ko ? "캐릭터 파일 내보내기" : "Export character files"}</summary><div><button type="button" disabled={!g || !draft.name.trim() || Array.from(draft.name.trim()).length > 12 || exporting} onClick={() => void exportFile("png")}><Download size={15} />{ko ? "이미지 저장" : "Save image"}</button><button type="button" disabled={!g || !draft.name.trim() || Array.from(draft.name.trim()).length > 12 || exporting} onClick={() => void exportFile("json")}><FileJson size={15} />{ko ? "특성 파일" : "Traits file"}</button></div><p role="status">{notice}</p>{artifact?.key === exportKey && <div className="guardian-export-result"><a href={artifact.href} download={artifact.filename}>{ko ? "파일 저장" : "Save file"} · {artifact.kind.toUpperCase()} ↓</a>{artifact.kind === "png" && <><img src={artifact.href} alt={ko ? `${draft.name} 캐릭터 이미지` : `${draft.name} character image`} width={1000} height={1200} /><p>{ko ? "모바일에서는 이미지를 길게 눌러 저장할 수도 있어요." : "On mobile, you can also hold the image to save it."}</p></>}</div>}</details>
    </div>;
}
