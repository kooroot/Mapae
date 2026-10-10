import {Web3Providers} from "../dapp/Web3Providers";
import {WalletGate} from "./WalletGate";
import {GuardianArcade} from "./nft/GuardianArcade";
import "./arcade.css";
import "./agent-arcade.css";
import "./arcade-brand.css";
import "./arcade-lobby.css";

export function Arcade() {
    return <Web3Providers><WalletGate>{(owner, initialGame, onGuest) => <GuardianArcade key={owner.toLowerCase()} owner={owner} initialGame={initialGame} onGuest={onGuest} />}</WalletGate></Web3Providers>;
}
