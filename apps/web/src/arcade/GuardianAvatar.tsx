import {useId} from "react";
import type {Color} from "./state";
import {BACKDROP_COLORS, SEAL_COLORS, type Guardian} from "./guardian";
import {guardianLayers} from "./guardian-layers";
import "./guardian.css";

export function GuardianAvatar({appearance, color = "red", portrait = false, className = ""}: {appearance?: Guardian; color?: Color; portrait?: boolean; className?: string}) {
    const tones = BACKDROP_COLORS[appearance?.backdrop ?? "dawn"];
    const id = useId();
    const layers = appearance ? guardianLayers(appearance) : [];
    return <svg viewBox="0 0 400 400" width={400} height={400} className={`arc-sprite arc-horse arc-guardian ${portrait ? "arc-guardian-portrait" : ""} ${className}`} aria-hidden="true" focusable="false">
        <defs>{layers.map((layer, i) => layer.clip && <clipPath key={i} id={`${id}-hat-${i}`} clipPathUnits="userSpaceOnUse"><rect {...layer.clip} /></clipPath>)}</defs>
        {portrait && <><rect width="400" height="400" rx="28" fill={tones[1]} /><circle cx="200" cy="186" r="156" fill={tones[0]} /><circle cx="200" cy="186" r="144" fill="none" stroke={tones[1]} strokeWidth="1" /><path d="M26 318 Q110 260 200 317 T400 314 V400 H0Z" fill={tones[0]} opacity=".2" /><path d="M35 69h24m-12-12v24M337 253h20m-10-10v20" stroke={tones[0]} strokeWidth="2" /></>}
        {appearance ? layers.map((layer, i) => <image key={`${layer.src}-${i}`} href={layer.src} x={layer.x} y={layer.y} width={layer.width} height={layer.height} clipPath={layer.clip ? `url(#${id}-hat-${i})` : undefined} preserveAspectRatio="xMidYMax meet" />) : <image href="/arcade/arcade-emblem.webp" x="95" y="75" width="210" height="236" />}
        {portrait && <><rect x="22" y="329" width="42" height="49" rx="8" fill={SEAL_COLORS[color]} /><image href="/arcade/arcade-emblem.webp" x="27" y="335" width="32" height="36" /><rect x="8" y="8" width="384" height="384" rx="22" fill="none" stroke={SEAL_COLORS[color]} strokeWidth="3" /></>}
    </svg>;
}
