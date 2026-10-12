import {createFileRoute} from "@tanstack/react-router";
import {FaucetPage} from "../../faucet/FaucetPage";

/** The Korean address for the dev faucet page. Same component as `/faucet` — see `ko/index.tsx`. */
export const Route = createFileRoute("/ko/faucet")({
    component: FaucetPage,
});
