import type {Locale} from "../lib/i18n";
import {guardianCanvas} from "./guardian-layers";
import type {Run} from "./state";

export async function createResultImage(run: Run, best: number, locale: Locale): Promise<string> {
    const art = new Image(); art.src = "/arcade/stamp-scene.webp";
    const emblem = new Image(); emblem.src = "/arcade/arcade-emblem.webp";
    const guardian = run.appearance ? await guardianCanvas(run.appearance) : null;
    await Promise.all([document.fonts.ready, art.decode(), emblem.decode()]);
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1280;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    const ko = locale === "ko";
    ctx.fillStyle = "#0e0c0a";
    ctx.fillRect(0, 0, 1080, 1280);
    ctx.fillStyle = "#faf6e9";
    ctx.fillRect(48, 48, 984, 1184);
    ctx.strokeStyle = "#252620";
    ctx.lineWidth = 3;
    ctx.strokeRect(48, 48, 984, 1184);
    const text = (value: string, x: number, y: number, size: number, fill = "#252620", weight = "600") => {
        ctx.fillStyle = fill;
        ctx.font = `${weight} ${size}px "Pretendard Variable", sans-serif`;
        ctx.fillText(value, x, y);
    };
    ctx.drawImage(art, 0, 120, art.naturalWidth, 390, 50, 50, 980, 210);
    if (guardian) ctx.drawImage(guardian, 810, 109, 210, 210);
    ctx.fillStyle = "#0e0c0ae6"; ctx.fillRect(50, 50, 980, 80);
    ctx.drawImage(emblem, 78, 57, 64, 64);
    text("MAPAE ARCADE", 164, 106, 34, "#e9c99f");
    text("PLAYER RECEIPT  —  01", 95, 225, 20, "#fff1cf");
    ctx.fillStyle = "#cb4938";
    ctx.fillRect(95, 238, 890, 4);
    text(ko ? "도깨비 도장찍기" : "Dokkaebi Stamp", 95, 325, 54);
    text(run.name, 95, 390, 32);
    text(run.score.toLocaleString(), 85, 595, 154, "#cb4938", "800");
    text("POINTS", 100, 643, 25);
    const rows = ko ? [
        ["최고 기록", `${best.toLocaleString()}점`],
        ["최대 콤보 / 퇴치", `${run.bestCombo} / ${run.hits}`],
        ["플레이 방식", "직접 연습 · 무료"],
        ["잘못 찍음 / 놓침", `${run.mistakes} / ${run.missed}`],
    ] : [
        ["Personal best", best.toLocaleString()],
        ["Best combo / Stamped", `${run.bestCombo} / ${run.hits}`],
        ["Play mode", "Free human practice"],
        ["Wrong stamps / Missed", `${run.mistakes} / ${run.missed}`],
    ];
    rows.forEach(([label, value], i) => {
        const y = 765 + i * 73;
        text(label!, 95, y, 29);
        ctx.textAlign = "right";
        text(value!, 978, y, 32);
        ctx.textAlign = "left";
    });
    ctx.setLineDash([7, 8]);
    ctx.strokeStyle = "#968d78";
    ctx.beginPath(); ctx.moveTo(95, 1065); ctx.lineTo(985, 1065); ctx.stroke();
    text(ko ? "직접 연습 · 무료 · 브라우저 기록" : "Free human practice · Local browser record", 95, 1120, 25);
    text("MAPAE ARCADE  /  mapae.io", 95, 1170, 23);
    return canvas.toDataURL("image/png");
}
