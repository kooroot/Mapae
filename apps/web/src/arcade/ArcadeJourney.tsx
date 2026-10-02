import {Check, Compass, Flag, Stamp, Store} from "lucide-react";
import type {GameId} from "@mapae/arcade";
import {GAME_NAMES} from "./game-names";

export function ArcadeJourney({ko, selectedCount, prepared}: {ko: boolean; selectedCount: number; prepared: boolean}) {
    return <nav className="arc-journey" aria-label={ko ? "외출 준비 바로가기" : "Prepare an outing"}>
        {[{href: "#arcade-crew", title: ko ? "친구 고르기" : "Your crew", subtitle: selectedCount ? ko ? `${selectedCount}명 함께해요` : `${selectedCount} selected` : ko ? "나만의 십이지신" : "Create a guardian", done: selectedCount > 0},
            {href: "#arcade-allowance", title: ko ? "용돈 준비" : "Allowance", subtitle: prepared ? ko ? "출발할 준비 완료" : "Ready to go" : ko ? "한도를 정해요" : "Set their limit", done: prepared},
            {href: "#arcade-history", title: ko ? "모험첩 펼치기" : "Your journal", subtitle: ko ? "놀다 온 이야기" : "Their little stories", done: false}].map((item, i) => <a key={item.href} href={item.href}><span className={item.done ? "is-done" : ""}>{item.done ? <Check size={17} /> : `0${i + 1}`}</span><div><b>{item.title}</b><small>{item.subtitle}</small></div></a>)}
    </nav>;
}

export function ArcadeDestination({ko, value, onChange}: {ko: boolean; value: GameId | "auto"; onChange: (game: GameId | "auto") => void}) {
    const names = GAME_NAMES[ko ? "ko" : "en"];
    return <div className="arc-destinations"><div className="arc-destinations-heading"><span>{ko ? "이번엔 어디로 갈까요?" : "Where shall they go?"}</span></div><div role="group" aria-label={ko ? "외출할 놀이 선택" : "Choose an outing"}>{[
        {id: "race" as const, label: names.race, Icon: Flag}, {id: "shop" as const, label: names.shop, Icon: Store},
        {id: "stamp" as const, label: names.stamp, Icon: Stamp}, {id: "auto" as const, label: ko ? "친구에게 맡기기" : "Let them choose", Icon: Compass},
    ].map(({id, label, Icon}) => <button key={id} aria-pressed={value === id} onClick={() => onChange(id)}><Icon size={17} /><span>{label}</span>{value === id && <Check size={14} />}</button>)}</div></div>;
}
