import {Check, LoaderCircle} from "lucide-react";
import {useEffect, useState} from "react";
import "./brand-controls.css";

/** Stages reflect confirmed work, never an estimated completion percentage. */
export function ActionProgress({steps, current, title, hint, ko}: {
    steps: readonly string[]; current: number; title: string; hint?: string; ko: boolean;
}) {
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        const started = Date.now();
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(timer);
    }, []);
    return <section className="mapae-progress" aria-label={title}>
        <div role="status"><LoaderCircle className="mapae-spinner" size={21} /><strong>{title}</strong></div>
        <ol>{steps.map((step, index) => <li key={step} aria-current={index === current ? "step" : undefined} data-done={index < current}>
            <span>{index < current ? <Check size={15} /> : index + 1}</span>{step}
        </li>)}</ol>
        {hint && <p>{hint}</p>}
        <small>{ko ? `${elapsed}초 경과` : `${elapsed}s elapsed`}{elapsed >= 30 && (ko ? " · 지갑과 네트워크 응답을 기다리고 있어요. 요청을 다시 보내지 마세요." : " · Waiting for your wallet or network. Do not submit again.")}</small>
    </section>;
}
