import {openStore, type PaymentSchedule} from "@mapae/store";
import {loadDelegatedAgentRuntime} from "@mapae/delegation";
import {redactForLog} from "@mapae/shared";
import {paymentExecutor, tick} from "./scheduler.js";
async function main() {
    const [command, argument] = process.argv.slice(2);
    if (!["add", "list", "runs", "cancel", "tick", "run"].includes(command ?? "")) {
        throw new Error("usage: bun run apps/payment-scheduler/index.ts add <spec.json> | list | runs <id> | cancel <id> | tick | run");
    }
    const store = openStore(process.env.SCHEDULER_DB_PATH ?? "./data/scheduler.sqlite");
    const print = (value: unknown) => console.log(JSON.stringify(value, (_, v) => typeof v === "bigint" ? String(v) : v, 2));
    try {
        if (command === "add") {
            if (!argument) throw new Error("schedule file required");
            const raw = await Bun.file(argument).json() as Record<string, unknown>;
            const spec: PaymentSchedule = {id: raw.id as string, resourcePath: raw.resourcePath as string, payTo: raw.payTo as PaymentSchedule["payTo"],
                maxAmountBase: BigInt(raw.maxAmountBase as string), maxTotalBase: BigInt(raw.maxTotalBase as string),
                maxRuns: raw.maxRuns as number, startsAt: raw.startsAt as number, endsAt: raw.endsAt as number,
                intervalMs: raw.intervalMs as number, maxAttempts: raw.maxAttempts as number, retryDelayMs: raw.retryDelayMs as number};
            print(store.schedules.add(spec)); return;
        }
        if (command === "list") {print(store.schedules.list()); return;}
        if (command === "runs" || command === "cancel") {
            if (!argument) throw new Error("job id required");
            if (command === "cancel") store.schedules.cancel(argument);
            print(command === "runs" ? store.schedules.runs(argument) : store.schedules.get(argument)); return;
        }
        // Loading keys/RPC is only needed when executing jobs, never for local management.
        const runtime = await loadDelegatedAgentRuntime();
        const execute = paymentExecutor(store.schedules, runtime);
        let running = true;
        const stop = () => {running = false;};
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
        do {
            await tick(store.schedules, async (job) => running ? execute(job) : {outcome: "unpaid", code: "STOPPED", retry: false});
            if (command === "tick" || !running) break;
            await Bun.sleep(1000);
        } while (running);
        process.off("SIGINT", stop); process.off("SIGTERM", stop);
    } finally {store.close();}
}
main().catch((error: unknown) => {console.error(redactForLog(error)); process.exitCode = 1;});
