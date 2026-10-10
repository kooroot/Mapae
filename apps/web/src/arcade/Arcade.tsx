import {Web3Providers} from "../dapp/Web3Providers";
import {WalletGate} from "./WalletGate";
import {GuardianArcade} from "./nft/GuardianArcade";
import {useArcadeMotion} from "./motion";
import "./arcade.css";
import "./agent-arcade.css";
import "./arcade-brand.css";
import "./arcade-lobby.css";

export function Arcade() {
    // The route root follows the OS preference; signed-in and practice shells add the player's own setting.
    const still = useArcadeMotion(false);
    return <Web3Providers><WalletGate reducedMotion={still}>{(owner, initialGame, onGuest) => <GuardianArcade key={owner.toLowerCase()} owner={owner} initialGame={initialGame} onGuest={onGuest} />}</WalletGate></Web3Providers>;
}
