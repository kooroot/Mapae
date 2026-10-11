import {Web3Providers} from "../dapp/Web3Providers";
import {ArcadeShell} from "./ArcadeShell";
import {useArcadeMotion} from "./motion";
import "./arcade-tokens.css";
import "./arcade.css";
import "./agent-arcade.css";
import "./arcade-brand.css";
import "./arcade-lobby.css";

export function Arcade() {
    // The route root follows the OS preference; practice shells add the player's own setting.
    const still = useArcadeMotion(false);
    return <Web3Providers><ArcadeShell reducedMotion={still} /></Web3Providers>;
}
