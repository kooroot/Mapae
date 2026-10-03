import type {ActivityOutcome} from "@mapae/arcade";
import type {Locale} from "../lib/i18n";
import "./turning-points.css";

export function TurningPoints({highlights, locale}: {highlights: ActivityOutcome["highlights"]; locale: Locale}) {
    if (!highlights?.length) return null;
    return <section className="arc-turning-points" aria-label={locale === "ko" ? "이번 판의 승부처" : "Turning points"}>
        <p className="arc-overline">{locale === "ko" ? "이번 판의 승부처" : "TURNING POINTS"}</p>
        <ol>{highlights.map((point, i) => <li key={i}><span aria-hidden="true">{String(i + 1).padStart(2, "0")}</span><p>{point[locale]}</p></li>)}</ol>
    </section>;
}
