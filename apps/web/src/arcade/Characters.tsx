import type {GameId} from "@mapae/arcade";

export const gameArt = (game: GameId) => `/arcade/${game}-scene.webp`;

/** Shared production sprites keep the same identity in portraits and playfields. */
export function Goblin({className = "", variant}: {className?: string; variant?: "armored" | "boss"}) {
    const asset = variant === "boss" ? "goblin-chief" : variant === "armored" ? "goblin-armored" : "goblin";
    return <img src={`/arcade/${asset}-512.webp`} width={512} height={512} className={`arc-sprite arc-goblin ${className}`} alt="" draggable={false} />;
}

export function GameArt({game, className = "", sizes = "(max-width: 720px) 100vw, 900px"}: {game: GameId; className?: string; sizes?: string}) {
    return <img src={gameArt(game)} srcSet={`/arcade/${game}-scene-640.webp 640w, /arcade/${game}-scene-960.webp 960w, ${gameArt(game)} 1536w`} sizes={sizes} width={1536} height={1024} className={`arc-scene ${className}`} alt="" draggable={false} />;
}
