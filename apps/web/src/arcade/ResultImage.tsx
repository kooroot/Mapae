import {useEffect, useState} from "react";
import {ArrowDownToLine} from "lucide-react";
import type {Locale} from "../lib/i18n";
import type {Run} from "./state";
import {createResultImage} from "./result-image";

export function ResultImage({run, best, locale}: {run: Run; best: number; locale: Locale}) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let current = true;
        setUrl(""); setError(false);
        void createResultImage(run, best, locale).then(value => {if (current) setUrl(value);})
            .catch(() => {if (current) setError(true);});
        return () => {current = false;};
    }, [run, best, locale, attempt]);
    const ko = locale === "ko";
    if (error) return <button className="arc-text-button" onClick={() => setAttempt(value => value + 1)}>{ko ? "이미지 생성 다시 시도" : "Retry result image"}</button>;
    if (!url) return <p role="status">{ko ? "이미지 만드는 중…" : "Making your image…"}</p>;
    return <div className="arc-image-export">
        <a className="arc-text-button" href={url} download={`mapae-arcade-${run.id}.png`}><ArrowDownToLine size={17} />{ko ? "결과 이미지 저장" : "Save result image"}</a>
        <details><summary>{ko ? "공유 이미지 미리보기" : "Preview share image"}</summary><img src={url} alt={ko ? `${run.name}의 ${run.score}점 오락 영수증` : `${run.name}'s ${run.score} point arcade receipt`} width="1080" height="1280" /><p>{ko ? "모바일에서는 이미지를 길게 눌러 저장할 수도 있어요." : "On mobile, you can also hold the image to save it."}</p></details>
    </div>;
}
