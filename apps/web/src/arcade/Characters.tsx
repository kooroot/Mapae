import type {GameId} from "@mapae/arcade";
import type {Color} from "./state";

export const gameArt = (game: GameId) => `/arcade/${game}-scene.webp`;
export const messengerArt = (color: Color) => `/arcade/messenger-${color}-512.webp`;

/** Shared production sprites keep the same identity in portraits and playfields. */
export function Horse({color = "red", className = ""}: {color?: Color; className?: string}) {
    return <img src={messengerArt(color)} width={1024} height={1024} className={`arc-sprite arc-horse arc-color-${color} ${className}`} alt="" draggable={false} />;
}

export function Goblin({className = ""}: {className?: string}) {
    return <img src="/arcade/goblin-512.webp" width={1024} height={1024} className={`arc-sprite arc-goblin ${className}`} alt="" draggable={false} />;
}

export function GameArt({game, className = "", sizes = "(max-width: 720px) 100vw, 900px"}: {game: GameId; className?: string; sizes?: string}) {
    return <img src={gameArt(game)} srcSet={`/arcade/${game}-scene-640.webp 640w, /arcade/${game}-scene-960.webp 960w, ${gameArt(game)} 1536w`} sizes={sizes} width={1536} height={1024} className={`arc-scene ${className}`} alt="" draggable={false} />;
}
