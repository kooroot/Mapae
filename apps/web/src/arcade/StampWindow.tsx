import {memo} from "react";
import type {Locale} from "../lib/i18n";
import {GuardianAvatar} from "./GuardianAvatar";
import {Goblin} from "./Characters";
import {BOSS_OPENINGS, type Actor, type Impact} from "@mapae/arcade/stamp";
import type {Character} from "./state";
import {SHARDS, type StampTap} from "./stamp-fx";

const COPY = {
    en: {goblin: "Goblin", courier: "Courier — do not stamp", empty: "Empty window", hit: "STAMPED", wrong: "FRIEND!", miss: "MISSED", friendly: "Don't stamp!", target: "Stamp!", passed: "PASSED ✓"},
    ko: {goblin: "도깨비", courier: "마패 배달부 — 누르지 마세요", empty: "빈 창문", hit: "퇴치", wrong: "아야!", miss: "놓쳤다", friendly: "통과!", target: "찍어!", passed: "통과 ✓"},
} satisfies Record<Locale, Record<string, string>>;

type WindowProps = {
    index: number; actor: Actor | null; locale: Locale; hintId: string; agent: boolean;
    /** Only an impact that is still showing; the arena drops expired ones so this window need not know the clock. */
    impact: Impact | null;
    /** The chief's phase and perfect band, the only clock-driven facts a window draws. */
    phase?: "guard" | "open" | "recover"; perfect: boolean;
    appearance: Character["appearance"]; color: Character["color"];
    onHit: (index: number, point?: StampTap["point"]) => void;
};

/**
 * One window of the courtyard. The engine replaces a cell's actor and impact objects whenever they change, and every other
 * prop is a primitive or stable, so the default shallow compare re-renders a window only when its actor, impact, chief phase
 * or perfect band changes, not on each 40ms paint of the arena.
 *
 * Its `stamp-fx` layer is never re-rendered: stamp-fx animates those spans when an event lands, so a score float or a crack
 * keeps playing after the engine's short-lived impact is gone. Afterimages of what just left (a squashed, sinking or flinching
 * face) belong to the impact instead and play as CSS on mount, resting in their end state so reduced motion shows the outcome.
 * `--life` paces the actor's telegraph (a look back, then sinking) over its stay: decoration only, never the judgement. It is
 * written through the CSSOM because the nonce-only CSP forbids style attributes.
 */
export const StampWindow = memo(function StampWindow({index, actor, impact, phase, perfect, locale, hintId, agent, appearance, color, onHit}: WindowProps) {
    const t = COPY[locale];
    const ko = locale === "ko";
    const bossCue = perfect ? ko ? "◆ 정통!" : "◆ PERFECT!" : phase === "open" ? ko ? `찍어! · ${actor!.hp}` : `OPEN! · ${actor!.hp}` : phase === "recover" ? ko ? "명중! 기다려" : "HIT! WAIT" : ko ? "방어 · 기다려" : "GUARD · WAIT";
    const targetCue = phase ? bossCue : actor?.special ? `${ko ? "갑옷" : "ARMOR"} · ${actor.hp}` : actor?.kind === "goblin" ? actor.golden ? ko ? "★ 금도깨비" : "★ GOLD" : t.target : t.friendly;
    return (
        <button className={`arc-window arc-flash-host ${actor ? `arc-has-${actor.kind}` : ""} ${impact ? `arc-impact-${impact.kind}` : ""} ${impact?.perfect ? "stamp-perfect-hit" : ""} ${actor?.golden ? "stamp-golden" : ""} ${actor?.special ? `stamp-${actor.special}` : ""} ${phase ? `stamp-boss-${phase}` : ""} ${perfect ? "stamp-boss-perfect" : ""}`}
            aria-describedby={phase ? hintId : undefined}
            data-testid={`cell-${index}`} data-actor={actor?.kind ?? "empty"} data-special={actor?.special ?? "normal"} data-boss-phase={phase} data-perfect={phase ? perfect : undefined} aria-disabled={agent}
            aria-label={`${index + 1}: ${actor ? actor.special ? `${ko ? actor.special === "boss" ? "대장 도깨비" : "갑옷 도깨비" : actor.special === "boss" ? "Chief goblin" : "Armored goblin"} ${phase ? bossCue : ""} · ${actor.hp} ${ko ? "번 남음" : "hits left"}` : actor.golden ? ko ? "금도깨비 · 보너스" : "Golden goblin · bonus" : t[actor.kind] : t.empty}`}
            onPointerDown={event => {if (event.button === 0) {event.preventDefault(); onHit(index, {x: event.clientX, y: event.clientY});}}}
            onClick={event => {if (event.detail === 0) onHit(index);}}>
            <span className="arc-window-number" aria-hidden="true">{index + 1}</span>
            <span className="arc-window-floor" />
            {actor && <span className="arc-window-actor" key={actor.bornAt} ref={el => {el?.style.setProperty("--life", `${actor.expiresAt - actor.bornAt}ms`);}}>
                {actor.kind === "goblin" ? <Goblin variant={actor.special} className={actor.golden ? "stamp-gold-art" : ""} /> : <GuardianAvatar appearance={appearance} color={color} />}
                <span className="arc-target-label">{targetCue}</span>
            </span>}
            {actor?.special && <progress className="stamp-enemy-hp" aria-label={ko ? "남은 타격" : "Hits remaining"} max={actor.special === "boss" ? BOSS_OPENINGS : 2} value={actor.hp} />}
            {impact?.kind === "miss" && <span className="stamp-escape" key={impact.until}><Goblin variant={impact.actor.special} className={impact.actor.golden ? "stamp-gold-art" : ""} /></span>}
            {impact && (impact.kind !== "crack" || impact.perfect) && <span className="arc-impact" key={impact.until} role={impact.perfect ? "status" : undefined}>
                {impact.kind === "stamp" && <Goblin variant={impact.actor.special} className={`stamp-squash${impact.actor.golden ? " stamp-gold-art" : ""}`} />}
                {impact.kind === "wrong" && <GuardianAvatar appearance={appearance} color={color} className="stamp-flinch" />}
                {impact.kind === "miss" && <i className="stamp-dust" />}
                {(impact.kind === "stamp" || impact.perfect) && <img className="arc-impact-art" src="/arcade/stamp-impact-512.webp" alt="" />}
                <b>{impact.perfect ? ko ? "◆ 정통!" : "◆ PERFECT!" : impact.kind === "stamp" ? t.hit : impact.kind === "wrong" ? t.wrong : impact.kind === "guard" ? ko ? "방어 중!" : "GUARDED!" : t.miss}</b>
                {impact.kind !== "miss" && impact.kind !== "guard" && <em>{impact.points > 0 ? "+" : ""}{impact.points}</em>}
            </span>}
            <span className="stamp-fx" aria-hidden="true">
                <i className="stamp-ink" /><i className="stamp-ring" /><i className="stamp-ring" />
                {SHARDS.map((_, i) => <i key={i} className="stamp-shard" />)}
                <i className="stamp-spark">✦</i><span className="stamp-strike"><i /><i /></span><i className="stamp-ripple" />
                <b className="stamp-float" /><b className="stamp-pass">{t.passed}</b>
            </span>
        </button>
    );
});
