import {createConfig, http} from "wagmi";
import {injected} from "wagmi/connectors";
import {chain, rpcUrl} from "./config";

/**
 * Mapae signs with the wallet already installed in the browser.
 *
 * Rabby, MetaMask and compatible injected wallets all enter through the same
 * connector. There is deliberately no project-id-backed relay connector here:
 * the owner's signing relationship stays between this origin and their wallet.
 */
export const wagmiConfig = createConfig({
    chains: [chain],
    connectors: [injected()],
    transports: {[chain.id]: http(rpcUrl)},
    ssr: true,
});

declare module "wagmi" {
    interface Register {
        config: typeof wagmiConfig;
    }
}
