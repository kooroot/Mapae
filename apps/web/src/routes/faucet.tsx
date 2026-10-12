import {createFileRoute} from "@tanstack/react-router";
import {FaucetPage} from "../faucet/FaucetPage";

/**
 * The faucet on a combined dev server. Production serves it at faucet.mapae.io's root
 * (`siteSurface === "faucet"`); this address exists so one `vite dev` shows every site.
 * The title, description and canonical come from the root route, which knows this path.
 */
export const Route = createFileRoute("/faucet")({
    component: FaucetPage,
});
