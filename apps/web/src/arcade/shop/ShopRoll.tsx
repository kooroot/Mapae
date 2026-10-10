import {useState} from "react";

/**
 * A tally that rolls to each new value: in from below when it grows, from above when it shrinks.
 * The first value simply sits there, so mounting the scoreboard or the forecast never animates.
 */
export function ShopRoll({value}: {value: number}) {
    const [shown, setShown] = useState(value);
    const [direction, setDirection] = useState<"up" | "down" | null>(null);
    // Adjusting state while rendering (React's "previous props" pattern): the roll starts in the same paint as the new number.
    if (value !== shown) {
        setShown(value);
        setDirection(value > shown ? "up" : "down");
    }
    return <span key={value} className="shop-roll" data-roll-dir={direction ?? undefined}>{value}</span>;
}
