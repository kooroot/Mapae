import type {Companion} from "./state";
import {BACKDROP_COLORS, SEAL_COLORS} from "./guardian";
import {guardianCanvas} from "./guardian-layers";

export async function guardianImage(member: Companion): Promise<string> {
    if (!member.appearance) throw new Error("Choose a guardian first");
    const g = member.appearance;
    const load = async (src: string) => {const image = new Image(); image.src = src; await image.decode(); return image;};
    const [body, emblem] = await Promise.all([guardianCanvas(g, 1000), load("/arcade/arcade-emblem.webp"), document.fonts.ready]);
    const canvas = document.createElement("canvas"); canvas.width = 1000; canvas.height = 1200;
    const c = canvas.getContext("2d"); if (!c) throw new Error("Canvas unavailable");
    const [light, dark] = BACKDROP_COLORS[g.backdrop];
    c.fillStyle = "#191611"; c.fillRect(0, 0, 1000, 1200);
    c.save(); c.translate(40, 40); c.scale(2.3, 2.3);
    c.fillStyle = dark; c.fillRect(0, 0, 400, 400); c.fillStyle = light; c.beginPath(); c.arc(200, 186, 156, 0, Math.PI * 2); c.fill();
    c.strokeStyle = dark; c.lineWidth = 1; c.beginPath(); c.arc(200, 186, 144, 0, Math.PI * 2); c.stroke();
    c.drawImage(body, 0, 0, 400, 400);
    c.strokeStyle = SEAL_COLORS[member.color]; c.lineWidth = 3; c.strokeRect(8, 8, 384, 384);
    c.fillStyle = SEAL_COLORS[member.color]; c.fillRect(22, 329, 42, 49); c.drawImage(emblem, 27, 335, 32, 36); c.restore();
    c.fillStyle = "#f2dfbe"; c.font = '600 52px "Pretendard Variable", sans-serif'; c.fillText(member.name, 58, 1040, 884);
    c.fillStyle = "#bca788"; c.font = '23px "IBM Plex Mono", monospace'; c.fillText("MAPAE · TWELVE GUARDIANS", 58, 1100);
    c.font = '18px "IBM Plex Mono", monospace'; c.fillText("LOCAL CHARACTER / NOT MINTED", 58, 1148);
    return canvas.toDataURL("image/png");
}
