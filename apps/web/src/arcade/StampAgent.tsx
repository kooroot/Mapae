import {useEffect, useState} from "react";
import type {AgentDecision} from "@mapae/arcade";
import type {AutonomousGameProps} from "./agent-contract";
import {Arena} from "./Arena";
import {stampHighlights} from "./game";
import {ArcadeSound} from "./sound";
import {ruleDecision} from "./agents";

export function StampAgent(props: AutonomousGameProps & {sound: ArcadeSound}) {
    const {profile, mode, decide, locale, budget, onComplete, onExit, reducedMotion, sound} = props;
    const [decision, setDecision] = useState<AgentDecision | null>(null);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const abort = new AbortController();
        const request = {kind: "stamp" as const, profile, locale, observation: {budget: budget.allowance, rules: "Stamp goblins, avoid couriers. Choose careful or quick tempo. Quick triggers fever immediately; careful waits for a gold parade or a chief opening. The chief only takes one hit in each of three openings. A deterministic motor obeys the same rules as a person."}};
        setError("");
        void (mode === "rules" ? Promise.resolve(ruleDecision(request)) : decide(request, abort.signal)).then(result => {
            if (abort.signal.aborted) return;
            if (result.source !== mode || (mode === "llm" && !result.model?.trim()) || !["careful", "quick"].includes(String(result.action.tempo))) throw new Error("Invalid stamp strategy");
            setDecision(result);
        }).catch(e => {if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Decision failed");});
        return () => abort.abort();
    }, [attempt]);
    if (!decision) return <section className="agent-wait"><h2>{locale === "ko" ? "어떻게 찍을지 생각 중…" : "Choosing a stamping strategy…"}</h2>{error && <><p role="alert">{error}</p><button className="arc-button" onClick={() => setAttempt(a => a + 1)}>{locale === "ko" ? "다시 판단" : "Retry decision"}</button></>}<button className="arc-text-button" onClick={onExit}>{locale === "ko" ? "외출 중단" : "Stop outing"}</button></section>;
    return <><p className="agent-thought"><b>{decision.model ?? (locale === "ko" ? "규칙 기반 에이전트" : "Rule agent")}</b> {decision.explanation}<small>{locale === "ko" ? "전략 판단 후 규칙 기반 손동작으로 실행해요." : "Strategy is executed by a rule-based motor."}</small></p>
        <Arena seed={props.seed} suspended={props.suspended} locale={locale} character={{...profile, appearance: props.appearance}} reducedMotion={reducedMotion} sound={sound} autopilot={decision.action.tempo === "quick" ? "quick" : "careful"} onFinish={game => onComplete({
            game: "stamp", score: game.score, summary: {ko: `${game.hits}번 찍고 최대 ${game.bestCombo}콤보를 만들었어요.`, en: `${game.hits} stamps, best combo ${game.bestCombo}.`},
            metrics: [{label: {ko: "최대 콤보", en: "Best combo"}, value: game.bestCombo}, {label: {ko: "퇴치", en: "Hits"}, value: game.hits}, {label: {ko: "실수", en: "Mistakes"}, value: game.mistakes}, {label: {ko: "갑옷 도깨비", en: "Armored goblins"}, value: game.armorHits}, {label: {ko: "대장 퇴치", en: "Chief defeated"}, value: game.bossDefeated}],
            highlights: stampHighlights(game),
            transcript: [{speaker: profile.name, text: decision.explanation}], ranking: [],
        })} /></>;
}
