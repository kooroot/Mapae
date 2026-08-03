import {
    AGENT_REQUEST_TIMEOUT_MS,
    loadDelegatedAgentRuntime,
    payForDelegatedResource,
    resolveResourceTarget,
} from "@mapae/delegation";
import {fromTokenAmount, redactForLog} from "@mapae/shared";

// The shared outermost budget — 15s here previously inverted the four-layer stack.
const REQUEST_TIMEOUT_MS = AGENT_REQUEST_TIMEOUT_MS;

async function main(): Promise<void> {
    const runtime = await loadDelegatedAgentRuntime();
    const target = resolveResourceTarget(
        runtime.sellerUrl,
        process.argv[2] ?? "/delegated/deliverable/inv-001",
    );

    console.log(`delegated agent ${runtime.account.address}`);
    console.log(`target          ${target}`);
    console.log("limit           enforced by parent erc20PeriodTransfer caveat");

    const result = await payForDelegatedResource(target, {
        provider: runtime.provider,
        preflight: runtime.preflight,
        delegationManager: runtime.delegationManager,
        trustedFacilitators: runtime.trustedFacilitators,
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!result.ok) {
        // Surface a reason instead of dying silently (D5). The reflected body is
        // never read, so no permission context can leak through the error.
        throw new Error(
            `payment failed [${result.code}]${
                result.status !== undefined ? ` ${result.status}` : ""
            }: ${result.detail}`,
        );
    }
    console.log(`402 → ${fromTokenAmount(BigInt(result.amount))} mUSDC to ${result.payTo}`);
    console.log("OK");
    console.log(`transaction     ${result.transaction ?? "(not returned)"}`);
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
