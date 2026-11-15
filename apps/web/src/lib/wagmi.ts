import {createConfig, http} from "wagmi";
import {injected} from "wagmi/connectors";
import {browserKey} from "./browser-key-connector";
import {chain, rpcUrl} from "./config";

/**
 * Mapae signs with the wallet already installed in the browser.
 *
 * Rabby, MetaMask and compatible injected wallets all enter through the same
 * connector. After it, the browser key ("Play without installing") gives a
 * visitor with no wallet a key generated on this device; the picker offers it
 * only when no injected wallet is found. There is still deliberately no
 * project-id-backed relay connector: the owner's signing relationship stays
 * between this origin and their wallet, and the browser key never leaves the
 * device except as signatures and signed transactions.
 */
export const wagmiConfig = createConfig({
    chains: [chain],
    connectors: [injected(), browserKey({confirm: request => import("../components/BrowserKeyConfirm").then(m => m.confirmInPage(request))})],
    transports: {[chain.id]: http(rpcUrl)},
    ssr: true,
});

declare module "wagmi" {
    interface Register {
        config: typeof wagmiConfig;
    }
}
