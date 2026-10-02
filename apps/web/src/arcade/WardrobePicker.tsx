import {useState, type ReactNode} from "react";
import {HATS, OUTFITS, SHOES, HAT_NAMES, OUTFIT_NAMES, SHOE_NAMES, WARDROBE_GROUPS, WARDROBE_PRESETS, wardrobeAsset, type Wardrobe, type WardrobeGroup} from "./wardrobe";

export function WardrobePicker({value, onChange, ko, lock}: {value?: Wardrobe; onChange: (w: Wardrobe | undefined) => void; ko: boolean; lock: (key: "hat" | "outfit" | "shoes", label: string) => ReactNode}) {
    const [group, setGroup] = useState<WardrobeGroup | "all">("all");
    const locale = ko ? "ko" : "en";
    const initial = WARDROBE_PRESETS[6]!.clothes;
    const selected = (w: Wardrobe) => !!value && value.hat === w.hat && value.outfit === w.outfit && value.shoes === w.shoes;
    return <section className="wardrobe-picker" aria-label={ko ? "조선 옷장" : "Joseon wardrobe"}>
        <div className="wardrobe-intro"><strong>{ko ? "오늘은 어떤 차림?" : "Who will you dress as?"}</strong><p>{ko ? "추천 한 벌로 시작하거나, 부위별로 마음껏 섞어요." : "Start with an outfit, or mix each piece your way."}</p></div>
        <div className="wardrobe-groups" role="group" aria-label={ko ? "추천 차림 분류" : "Outfit groups"}>
            <button type="button" aria-pressed={group === "all"} onClick={() => setGroup("all")}>{ko ? "모두" : "All"}</button>
            {(Object.keys(WARDROBE_GROUPS) as WardrobeGroup[]).map(key => <button type="button" key={key} aria-pressed={group === key} onClick={() => setGroup(key)}>{WARDROBE_GROUPS[key][locale]}</button>)}
        </div>
        <div className="wardrobe-presets">{WARDROBE_PRESETS.filter(p => group === "all" || p.group === group).map(p => <button type="button" key={p.id} aria-label={`${p.name[locale]} ${ko ? "차림" : "outfit"}`} aria-pressed={selected(p.clothes)} onClick={() => onChange({...p.clothes})}>
            <img src={wardrobeAsset("outfit", p.clothes.outfit)} width={64} height={64} alt="" loading="lazy" /><strong>{p.name[locale]}</strong><small>{WARDROBE_GROUPS[p.group][locale]}</small>
        </button>)}</div>
        <button className="wardrobe-original" type="button" aria-pressed={!value} onClick={() => onChange(undefined)}>{ko ? "기본 마패 전령 차림" : "Original Mapae courier"}</button>
        <div className="guardian-field-label"><strong>{ko ? "모자 · 머리" : "Headwear"}</strong>{lock("hat", ko ? "모자" : "Headwear")}</div>
        <div className="wardrobe-parts" role="group" aria-label={ko ? "모자 선택" : "Choose headwear"}>{HATS.map(hat => <button type="button" key={hat} aria-label={HAT_NAMES[hat][locale]} aria-pressed={value?.hat === hat} onClick={() => onChange({...(value ?? initial), hat})}>
            {hat === "none" ? <span className="wardrobe-none" aria-hidden="true">—</span> : <img src={wardrobeAsset("hat", hat)} width={64} height={48} alt="" loading="lazy" />}<span>{HAT_NAMES[hat][locale]}</span>
        </button>)}</div>
        <div className="guardian-field-label"><strong>{ko ? "의복" : "Clothing"}</strong>{lock("outfit", ko ? "의복" : "Clothing")}</div>
        <div className="wardrobe-parts" role="group" aria-label={ko ? "의복 선택" : "Choose clothing"}>{OUTFITS.map(outfit => <button type="button" key={outfit} aria-label={OUTFIT_NAMES[outfit][locale]} aria-pressed={value?.outfit === outfit} onClick={() => onChange({...(value ?? initial), outfit})}>
            <img src={wardrobeAsset("outfit", outfit)} width={64} height={64} alt="" loading="lazy" /><span>{OUTFIT_NAMES[outfit][locale]}</span>
        </button>)}</div>
        <div className="guardian-field-label"><strong>{ko ? "신발" : "Footwear"}</strong>{lock("shoes", ko ? "신발" : "Footwear")}</div>
        <div className="wardrobe-parts" role="group" aria-label={ko ? "신발 선택" : "Choose footwear"}>{SHOES.map(shoes => <button type="button" key={shoes} aria-label={SHOE_NAMES[shoes][locale]} aria-pressed={value?.shoes === shoes} onClick={() => onChange({...(value ?? initial), shoes})}>
            <img src={wardrobeAsset("shoes", shoes)} width={64} height={48} alt="" loading="lazy" /><span>{SHOE_NAMES[shoes][locale]}</span>
        </button>)}</div>

    </section>;
}
