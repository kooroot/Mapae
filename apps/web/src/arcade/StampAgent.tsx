import {useEffect, useState} from "react";
import type {AgentDecision} from "@mapae/arcade";
import type {AutonomousGameProps} from "./agent-contract";
import {Arena} from "./Arena";
import {stampOutcome} from "@mapae/arcade/simulation";
import {ruleDecision} from "./agents";

export function StampAgent(props: AutonomousGameProps) {
    const {profile, mode, decide, locale, budget, onComplete, onExit, reducedMotion, sound} = props;
    const [decision, setDecision] = useState<AgentDecision | null>(null);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const abort = new AbortController();
        const request = {kind: "stamp" as const, profile, locale, observation: {budget: budget.allowance, rules: "Stamp goblins, avoid couriers. Choose careful or quick tempo. Quick hits the first chief opening and triggers fever immediately; careful aims for the visible precision band and saves fever for gold or a precise chief hit. The chief only takes one hit in each of three openings. A precise stamp adds 200 points; an early guarded tap spends that cycle's precision chance. A deterministic motor obeys the same rules as a person."}};
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
        <Arena seed={props.seed} aptitudes={profile.aptitudes} suspended={props.suspended} locale={locale} character={{...profile, appearance: props.appearance}} reducedMotion={reducedMotion} sound={sound} autopilot={decision.action.tempo === "quick" ? "quick" : "careful"} onFinish={game => onComplete(stampOutcome(game, profile.name, decision.explanation))} /></>;
}
