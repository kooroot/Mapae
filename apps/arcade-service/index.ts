import {openStore} from "@mapae/store";
import {openArcadeStore} from "@mapae/store/arcade";
import {getAddress, isAddress, zeroAddress} from "viem";
import {createArcadeApp} from "./app.js";
import {createModel, localURL, modelConfig} from "./model.js";
import {createPayments, type PaymentOptions} from "./payments.js";
import {createSimulation} from "./simulation.js";
import {createFork} from "./fork.js";

export function paymentMode(env: Record<string, string | undefined>): "disabled" | "simulation" | "fork" {
    const mode = env.ARCADE_PAYMENT_MODE ?? "disabled";
    if (mode !== "disabled" && mode !== "simulation" && mode !== "fork") throw new Error("GIWA live payments are disabled. ARCADE_PAYMENT_MODE must be disabled, simulation, or fork.");
    if (mode === "fork") {
        // Never let the runtime's public-RPC default escape this boundary.
        localURL(env.GIWA_SEPOLIA_RPC_URL ?? "");
        if (env.FACILITATOR_URL) throw new Error("Arcade fork uses its own Anvil-only facilitator; external FACILITATOR_URL is forbidden");
        if (env.ARCADE_ALLOW_LOCAL_FORK !== "true") throw new Error("Fork settlement requires explicit ARCADE_ALLOW_LOCAL_FORK=true");
    }
    return mode;
}
async function main() {
    const mode = paymentMode(process.env), config = modelConfig(process.env);
    const prefix = process.env.ARCADE_STORE_PREFIX ?? "./data/arcade";
    const admissions = openArcadeStore(`${prefix}-${mode}-admissions.sqlite`);
    const modelBudget = openArcadeStore(`${prefix}-model.sqlite`);
    const store = openStore(`${prefix}-${mode}-payments.sqlite`);
    let options: PaymentOptions | undefined;
    if (mode === "simulation") options = await createSimulation(store);
    if (mode === "fork") {
        const payTo = process.env.ARCADE_PAY_TO ?? "";
        if (!isAddress(payTo) || getAddress(payTo) === zeroAddress) throw new Error("ARCADE_PAY_TO must be a nonzero receiving address");
        options = await createFork(store, process.env);
    }
    const app = createArcadeApp(createModel(config, modelBudget), createPayments(store, admissions, options));
    const server = Bun.serve({hostname: "127.0.0.1", port: 3004, idleTimeout: 120, maxRequestBodySize: 16_384, fetch: app.fetch});
    console.log(`Mapae Arcade local service http://127.0.0.1:${server.port} · model ${config.provider} · payments ${mode} · GIWA broadcast disabled`);
}
if (import.meta.main) main().catch(() => {console.error("Arcade service configuration failed. Check the local service README; credentials and provider details are not logged."); process.exitCode = 1;});
