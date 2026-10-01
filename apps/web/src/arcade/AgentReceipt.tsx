import {ARCADE_TICKET_COST} from "@mapae/arcade/tickets";
import {MOCK_USDC} from "@mapae/shared";
import {useEffect, useState} from "react";
import type {Locale} from "../lib/i18n";
import type {Activity} from "./activity";
import {explorerTxUrl} from "../lib/config";
import {isHash} from "viem";
import {GAME_NAMES} from "./game-names";
import {GuardianAvatar} from "./GuardianAvatar";
import {guardianCanvas} from "./guardian-layers";
import {GameArt, gameArt} from "./Characters";

export function AgentReceipt({activity: a, locale, best}: {activity: Activity; locale: Locale; best: number}) {
    const ko = locale === "ko";
    const [image, setImage] = useState("");
    const [imageError, setImageError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let active = true; setImage(""); setImageError(false);
        void receiptImage(a, locale).then(url => {if (active) setImage(url);}).catch(() => {if (active) setImageError(true);});
        return () => {active = false;};
    }, [a, locale, attempt]);
    return <section className="agent-receipt"><div className="agent-receipt-paper"><GameArt game={a.game} className="agent-receipt-art" /><p className="arc-overline">MAPAE ARCADE / {ko ? "에이전트 외출 영수증" : "AGENT OUTING RECEIPT"}</p><GuardianAvatar appearance={a.appearance} color={a.color} className="guardian-receipt-avatar" /><h1>{a.name}{ko ? "의 오늘 한 판" : "'s arcade story"}</h1><p className="agent-receipt-source">{a.mode === "llm" ? a.model ?? "LLM AGENT" : "RULE BOT"} · {GAME_NAMES[locale][a.game]}</p>
        <h2>{a.outcome?.summary[locale] ?? (ko ? "외출을 마치지 않았어요." : "This outing was not completed.")}</h2>
        {a.outcome && <><div className="agent-total"><strong>{a.outcome.score.toLocaleString()}</strong><span>{ko ? "이번 놀이 점수" : "ACTIVITY SCORE"}<br />{ko ? "최고 기록" : "BEST"} {best.toLocaleString()}</span></div><dl className="agent-metrics">{a.outcome.metrics.map((m, i) => <div key={i}><dt>{m.label[locale]}</dt><dd>{Number.isInteger(m.value) ? m.value.toLocaleString() : m.value.toFixed(1)} {m.unit ?? ""}</dd></div>)}</dl></>}
        <dl className="arc-receipt-lines"><div><dt>{ko ? "입장권" : "Admission"}</dt><dd>{`${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} · GIWA SEPOLIA`}</dd></div><div><dt>{ko ? "스마트 계정 잔액" : "Smart-account balance"}</dt><dd>{a.giwa.balanceAfter ?? "—"} {MOCK_USDC.symbol}</dd></div><div><dt>{ko ? "입장 후 남은 용돈" : "Allowance after entry"}</dt><dd>{a.giwa.allowanceAfter ?? "—"} {MOCK_USDC.symbol}</dd></div>{a.ticketId && <div><dt>{ko ? "티켓 번호" : "Ticket"}</dt><dd>{a.source === "mapae-giwa" && isHash(a.ticketId) ? <a href={explorerTxUrl(a.ticketId)} target="_blank" rel="noreferrer">GIWA ↗ {a.ticketId.slice(0, 12)}…</a> : `${a.ticketId.slice(0, 16)}…`}</dd></div>}</dl><p className="agent-thought">“{a.reason}”</p><p className="arc-receipt-disclaimer">{ko ? "결제 내역은 GIWA에서 확인 · 점수와 이야기는 이 브라우저의 기록" : "Verify payment on GIWA · Scores and stories are local browser records"}</p></div>
        <div className="agent-receipt-story">{a.outcome && a.outcome.ranking.length > 0 && <section><h2>{ko ? "같은 출발선에서" : "Same starting line"}</h2><p>{ko ? "같은 초기 자본·경기 조건의 시스템 상대와 비교해요. 글로벌 랭킹이 아니에요." : "System opponents under equal starting conditions. Not a global ranking."}</p><ol className="agent-ranking">{a.outcome.ranking.map((r, i) => <li key={i}><b>{1 + (a.outcome?.ranking.filter(other => other.score > r.score).length ?? 0)}</b><span>{r.name}</span><strong>{r.score.toLocaleString()}</strong></li>)}</ol></section>}
        {a.outcome && <details open><summary>{ko ? "무슨 일이 있었나요?" : "What happened?"}</summary><ol className="agent-transcript">{a.outcome.transcript.map((m, i) => <li key={i}><b>{m.speaker}</b><p>{m.text}</p></li>)}</ol></details>}
        {image ? <><a className="arc-button arc-button-paper" href={image} download={`mapae-agent-${a.id}.png`}>{ko ? "외출 영수증 이미지 저장 ↓" : "Save receipt image ↓"}</a><details><summary>{ko ? "공유 이미지 미리보기" : "Preview share image"}</summary><img className="agent-share-image" src={image} width={1080} height={1440} alt={ko ? `${a.name}의 외출 영수증` : `${a.name}'s outing receipt`} /><small>{ko ? "모바일에서는 길게 눌러 저장하세요." : "On mobile, hold to save."}</small></details></> : imageError ? <button className="arc-text-button" onClick={() => setAttempt(n => n + 1)}>{ko ? "이미지 다시 만들기" : "Retry image"}</button> : <p role="status">{ko ? "공유 영수증을 만들어요…" : "Preparing your receipt…"}</p>}
        </div></section>;
}

async function receiptImage(a: Activity, locale: Locale): Promise<string> {
    const art = new Image(); art.src = gameArt(a.game);
    const emblem = new Image(); emblem.src = "/arcade/arcade-emblem.webp";
    const guardian = a.appearance ? await guardianCanvas(a.appearance) : null;
    await Promise.all([document.fonts.ready, art.decode(), emblem.decode()]);
    const ko = locale === "ko";
    const canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1440;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas unavailable");
    const c: CanvasRenderingContext2D = context;
    c.fillStyle = "#0e0c0a"; c.fillRect(0, 0, 1080, 1440); c.fillStyle = "#fffbed"; c.fillRect(48, 48, 984, 1344);
    c.strokeStyle = "#282d26"; c.lineWidth = 4; c.strokeRect(48, 48, 984, 1344);
    c.drawImage(art, 0, 180, art.naturalWidth, 390, 50, 50, 980, 248);
    if (guardian) c.drawImage(guardian, 810, 137, 210, 210);
    c.fillStyle = "#0e0c0aeb"; c.fillRect(50, 50, 980, 86);
    c.drawImage(emblem, 78, 61, 64, 64);
    c.fillStyle = "#fff1cf"; c.font = 'bold 32px "Pretendard Variable", sans-serif'; c.fillText("MAPAE ARCADE / AGENT RECEIPT", 164, 107);
    c.fillStyle = "#282d26"; c.font = 'bold 62px "Pretendard Variable", sans-serif'; c.fillText(a.name.slice(0, 24), 98, 375, 884);
    c.font = '24px "Pretendard Variable", sans-serif'; c.fillText(`${GAME_NAMES[locale][a.game]} · ${a.mode === "llm" ? a.model ?? "LLM" : "RULE BOT"}`, 98, 420, 884);
    c.font = 'bold 132px "IBM Plex Mono", monospace'; c.fillText(String(a.outcome?.score ?? 0), 98, 565, 870);
    c.font = '24px "Pretendard Variable", sans-serif'; c.fillText(ko ? "이번 놀이 점수" : "ACTIVITY SCORE", 98, 611);
    function wrap(value: string, y: number, maxLines = 3): number {
        let line = ""; let lines = 0;
        for (const character of Array.from(value)) {
            if (c.measureText(line + character).width > 874) {c.fillText(line, 98, y); y += 39; line = ""; if (++lines >= maxLines) return y;}
            line += character;
        }
        if (line) c.fillText(line, 98, y); return y + 48;
    }
    c.font = '28px "Pretendard Variable", sans-serif';
    let y = wrap(a.outcome?.summary[locale] ?? (ko ? "외출 중단" : "Outing interrupted"), 674, 2);
    for (const metric of (a.outcome?.metrics ?? []).slice(0, 5)) {
        c.fillText(metric.label[locale], 98, y); c.textAlign = "right"; c.fillText(`${Math.round(metric.value * 10) / 10} ${metric.unit ?? ""}`, 974, y); c.textAlign = "left"; y += 47;
    }
    y = Math.max(y + 25, 1050); c.fillStyle = "#a94334";
    c.fillText(`${ko ? "입장" : "ADMISSION"}: ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} · GIWA SEPOLIA`, 98, y, 874);
    c.fillStyle = "#282d26"; c.font = '25px "Pretendard Variable", sans-serif';
    c.fillText(`${ko ? "남은 용돈" : "ALLOWANCE"} ${a.giwa.allowanceAfter ?? "—"} ${MOCK_USDC.symbol} / ${ko ? "잔액" : "BALANCE"} ${a.giwa.balanceAfter ?? "—"} ${MOCK_USDC.symbol}`, 98, y + 52);
    c.font = '23px "Pretendard Variable", sans-serif'; wrap(a.outcome?.transcript.at(-1)?.text ?? a.reason, y + 122, 3);
    c.fillStyle = "#6f7568"; c.font = '20px "Pretendard Variable", sans-serif'; c.fillText(ko ? "GIWA 테스트넷 결제 · 점수는 브라우저 기록" : "GIWA TESTNET PAYMENT · LOCAL BROWSER SCORE", 98, 1324, 880);
    return canvas.toDataURL("image/png");
}
