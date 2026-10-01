import {Dialog} from "@base-ui/react/dialog";
import {BrandSelect} from "../components/BrandSelect";
import {useEffect, useId, useRef, useState} from "react";
import {Check, Plus, X, Bot, Sparkles} from "lucide-react";
import type {AgentMode} from "@mapae/arcade";
import {addCharacter, MAX_CHARACTERS, newCompanion, updateCharacter, type Companion, type ArcadeState} from "./state";
import {GuardianAvatar} from "./GuardianAvatar";
import {GuardianCustomizer} from "./GuardianCustomizer";
import {guardianSeed, rollGuardian, GUARDIAN_NAMES} from "./guardian";
import {GAME_NAMES} from "./game-names";
import "./roster.css";

export function CharacterRoster({demo, ready, update, selected, onSelect, ko}: {
    demo: ArcadeState; ready: boolean; update: (fn: (d: ArcadeState) => ArcadeState) => ArcadeState;
    selected: string[]; onSelect: (ids: string[]) => void; ko: boolean;
}) {
    const [editing, setEditing] = useState<Companion | null>(null);
    const [creating, setCreating] = useState(false);
    const personalities = ko ? {curious: "호기심", bold: "과감함", calm: "신중함"} : {curious: "Curious", bold: "Bold", calm: "Calm"};
    return <section id="arcade-crew" className="arc-roster" aria-labelledby="roster-title">
        <div className="arc-roster-heading"><div><span className="arc-overline">YOUR LITTLE CREW</span><h2 id="roster-title">{ko ? "내 캐릭터들" : "Your characters"} <small>{demo.characters.length} / {MAX_CHARACTERS}</small></h2></div><button className="arc-roster-add" disabled={!ready || demo.characters.length >= MAX_CHARACTERS} onClick={() => {
            setCreating(true); setEditing(rollGuardian(newCompanion(crypto.randomUUID(), {name: "", color: "red", temperament: "curious"}), guardianSeed()));
        }}><Plus size={17} />{ko ? "캐릭터 만들기" : "New character"}</button></div>
        {demo.characters.length === 0 && <div className="arc-roster-empty"><span aria-hidden="true">＋</span><div><strong>{ko ? "아직 만든 캐릭터가 없어요" : "Your crew starts here"}</strong><p>{ko ? "이름과 성향을 정해 첫 친구를 만들어 주세요." : "Give your first character a name and a personality."}</p></div></div>}
        <div className="arc-roster-strip">{demo.characters.map(c => <article key={c.id} className={`arc-companion ${selected.includes(c.id) ? "is-selected" : ""}`}>
            <button className="arc-companion-pick" aria-label={ko ? `${c.name} 보내기 선택` : `Select ${c.name} for an outing`} aria-pressed={selected.includes(c.id)} disabled={!ready} onClick={() => onSelect(selected.includes(c.id) ? selected.filter(id => id !== c.id) : [...selected, c.id])}>
                <span className="arc-companion-check" aria-hidden="true">{selected.includes(c.id) && <Check size={14} />}</span><GuardianAvatar appearance={c.appearance} color={c.color} portrait /><strong>{c.name}</strong><span>{personalities[c.temperament]} · {c.agent.mode === "llm" ? "LLM" : ko ? "규칙 봇" : "Rule bot"}</span><small>{c.appearance ? GUARDIAN_NAMES[ko ? "ko" : "en"][c.appearance.zodiac] : ko ? "모습을 골라 주세요" : "Choose a guardian"} · {ko ? `${c.agent.rounds}회 외출` : `${c.agent.rounds} visit(s)`}</small>
            </button><button className="arc-companion-edit" aria-label={ko ? `${c.name} 설정` : `Edit ${c.name}`} disabled={!ready} onClick={() => {setCreating(false); setEditing(c);}}>{ko ? "설정 · 기록" : "Edit & records"} ↗</button>
        </article>)}</div>
        {demo.characters.length > 0 && <div className="arc-roster-selection"><p>{selected.length ? ko ? `${selected.length}명 선택 · 한 명씩 차례로 출발해요.` : `${selected.length} selected · Heading out one at a time.` : ko ? "놀러 보낼 캐릭터를 골라 주세요." : "Choose who is heading out."}</p><button className="arc-text-button" disabled={!ready} onClick={() => onSelect(selected.length === demo.characters.length ? [] : demo.characters.map(c => c.id))}>{selected.length === demo.characters.length ? ko ? "선택 해제" : "Clear selection" : ko ? "모두 선택" : "Select all"}</button></div>}
        {editing && <CharacterEditor key={editing.id} member={editing} creating={creating} ko={ko} onClose={() => setEditing(null)} onSave={member => {
            const next = update(d => creating ? addCharacter(d, member) : updateCharacter(d, member.id, {name: member.name, color: member.color, appearance: member.appearance, temperament: member.temperament, agent: member.agent, configured: true}));
            if (creating && next.characters.some(c => c.id === member.id)) onSelect([...selected, member.id]);
            setEditing(null);
        }} />}
    </section>;
}

export function CharacterEditor({member, creating, ko, onClose, onSave}: {member: Companion; creating: boolean; ko: boolean; onClose: () => void; onSave: (c: Companion) => void}) {
    const [draft, setDraft] = useState(member);
    const [nameTouched, setNameTouched] = useState(false);
    const nameInput = useRef<HTMLInputElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const nameHelp = useId();
    useEffect(() => {
        const viewport = window.visualViewport;
        if (!viewport) return;
        // Mobile keyboards can shrink the visual viewport without changing dvh.
        const sync = () => {
            dialog.current?.style.setProperty("--arc-dialog-height", `${viewport.height}px`);
            dialog.current?.style.setProperty("--arc-dialog-top", `${viewport.offsetTop + viewport.height / 2}px`);
        };
        sync(); viewport.addEventListener("resize", sync); viewport.addEventListener("scroll", sync);
        return () => {viewport.removeEventListener("resize", sync); viewport.removeEventListener("scroll", sync);};
    }, []);
    const nameLength = Array.from(draft.name.trim()).length;
    const nameValid = nameLength > 0 && nameLength <= 12;
    const showNameError = !nameValid && (nameTouched || nameLength > 12);
    const valid = !!draft.appearance && nameValid;
    return <Dialog.Root open onOpenChange={open => {if (!open) onClose();}}><Dialog.Portal className="arc-ui-theme"><Dialog.Backdrop className="arc-editor-backdrop" /><Dialog.Popup ref={dialog} className="arc-character-dialog" initialFocus={kind => kind === "touch" ? true : nameInput.current}>
        <form onSubmit={e => {e.preventDefault(); setNameTouched(true); if (valid) onSave({...draft, name: draft.name.trim(), configured: true});}}>
            <div className="arc-editor-heading"><div><span className="arc-overline">MAPAE · TWELVE GUARDIANS</span><Dialog.Title>{creating ? ko ? "십이지신 캐릭터 공방" : "Create your guardian" : ko ? `${member.name}의 캐릭터 설정` : `Edit ${member.name}`}</Dialog.Title></div><button type="button" aria-label={ko ? "닫기" : "Close"} onClick={onClose}><X size={20} /></button></div>
            <Dialog.Description className="arc-editor-note">{ko ? "주사위로 만나고, 내 취향으로 완성해요." : "Meet by chance. Make them your own."}</Dialog.Description>
            <label>{ko ? "캐릭터 이름" : "Character name"}<input ref={nameInput} autoComplete="off" maxLength={24} placeholder={ko ? "친구의 이름을 지어 주세요" : "Give your guardian a name"} value={draft.name} onChange={e => setDraft({...draft, name: e.target.value})} onBlur={() => setNameTouched(true)} aria-invalid={showNameError} aria-describedby={nameHelp} /></label><small id={nameHelp} className={showNameError ? "arc-name-error" : ""} aria-live="polite">{showNameError ? nameLength === 0 ? ko ? "이름을 입력해 주세요." : "Please enter a name." : ko ? "이름은 12자까지 쓸 수 있어요." : "Names can be up to 12 characters." : ko ? "이름 1–12자 · 앞뒤 공백은 제외해요" : "1–12 characters; leading and trailing spaces are trimmed"} <span className="arc-name-count">{nameLength} / 12</span></small>
            <p className="guardian-name-note">{ko ? "이름은 자유롭게 지어요. 주사위를 굴려도 바뀌지 않아요." : "Choose any name. Rolling the dice never changes it."}</p>
            <GuardianCustomizer draft={draft} onChange={setDraft} ko={ko} />

            <details className="guardian-agent-settings"><summary>{ko ? "에이전트 놀이 설정" : "Agent play settings"}</summary>
            <div className="agent-pair">
                <label>{ko ? "에이전트 종류" : "Controller"}<BrandSelect<AgentMode> value={draft.agent.mode} onValueChange={mode => setDraft({...draft, agent: {...draft.agent, mode}})} options={[
                    {value: "rules", label: ko ? "규칙 기반 봇" : "Rule bot", description: ko ? "모델 호출 없이 바로 출발" : "Ready to play, no model calls", icon: <Bot />},
                    {value: "llm", label: ko ? "실제 LLM" : "Actual LLM", description: ko ? "별도 모델 서버 연결 필요" : "Requires a connected model service", icon: <Sparkles />},
                ]} /></label>
                <label>{ko ? "최대 입장 횟수" : "Maximum visits"}<BrandSelect value={draft.agent.rounds} onValueChange={rounds => setDraft({...draft, agent: {...draft.agent, rounds}})} options={[1, 2, 3].map(value => ({value, label: `${value}${ko ? "회" : " visit(s)"}`}))} /></label>
            </div>
            <p className="arc-editor-note">{draft.agent.mode === "rules" ? ko ? "규칙 봇은 모델을 호출하지 않아요. LLM이 아니에요." : "Rule bots do not call a model. They are not LLMs." : ko ? "LLM 서버 연결이 필요해요. 연결 실패 시 봇으로 바꾸지 않아요." : "Requires an LLM service. Failed calls never switch to a bot."}</p>
            </details>
            {!creating && <dl className="arc-character-records"><div><dt>{GAME_NAMES[ko ? "ko" : "en"].race}</dt><dd>{member.bests.race}</dd></div><div><dt>{GAME_NAMES[ko ? "ko" : "en"].shop}</dt><dd>{member.bests.shop}</dd></div><div><dt>{ko ? "도장찍기 봇" : "Stamp bot"}</dt><dd>{member.bests.stamp}</dd></div><div><dt>{ko ? "직접 플레이" : "Human play"}</dt><dd>{member.best}</dd></div></dl>}
            <button type="submit" className="arc-button" disabled={!valid}>{creating ? ko ? "캐릭터 만들기" : "Create character" : ko ? "설정 저장" : "Save changes"} <span>→</span></button>
        </form>
    </Dialog.Popup></Dialog.Portal></Dialog.Root>;
}
