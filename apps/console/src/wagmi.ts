import {createConfig, http} from "wagmi";
import {injected} from "wagmi/connectors";
import {chain, rpcUrl} from "./config";

/**
 * Wallet connection for the one thing this console writes: revocation.
 *
 * `injected()` only — no WalletConnect. The owner key is a browser wallet in the demo, and
 * a relay-based connector would need a project id and a third-party relay for a flow whose
 * whole point is that authority stays local.
 *
 * Chain and transport come from `./config`, never a second copy: the console reads state
 * through `publicClient` on the same endpoint the wallet is asked to sign for, and a
 * mismatch between them would show one chain's delegation while signing for another.
 */
export const wagmiConfig = createConfig({
    chains: [chain],
    connectors: [injected()],
    transports: {[chain.id]: http(rpcUrl)},
});

declare module "wagmi" {
    interface Register {
        config: typeof wagmiConfig;
    }
}
