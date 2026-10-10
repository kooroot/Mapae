import type {Game, StampEvent} from "@mapae/arcade/stamp";
import type {ArcadeSound, SoundKind} from "./sound";

/** Where a Dokkaebi Stamp round sends its feedback. */
export type StampFx = {sound: ArcadeSound};

/** One cue per step, the most telling first, so a hit that also starts fever does not stack two chimes. */
function cue(events: readonly StampEvent[]): SoundKind | null {
    const has = (type: StampEvent["type"]) => events.some(event => event.type === type);
    if (has("perfect")) return "perfect";
    if (has("feverStart")) return "fever";
    const hit = events.find(event => event.type === "hit");
    if (hit) return hit.actor.golden ? "golden" : "hit";
    if (has("crack")) return "hit";
    if (has("guard")) return "guard";
    if (has("wrong")) return "wrong";
    return null;
}

/** The one place a round's events become feedback, whether a person or an agent is playing. `game` is the state after them. */
export function stampFx(events: readonly StampEvent[], game: Game, {sound}: StampFx) {
    const kind = cue(events);
    if (kind) sound.play(kind, game.combo);
    if (events.some(event => event.type === "finished")) sound.play("end");
}

/** The countdown reaching zero. */
export function stampStartFx({sound}: StampFx) {
    sound.play("start");
}
