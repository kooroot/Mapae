import {
    AGENT_REQUEST_TIMEOUT_MS,
    loadDelegatedAgentRuntime,
    payForDelegatedResource,
    resolveResourceTarget,
    type AgentSpendPolicy,
} from "@mapae/delegation";
import {fromTokenAmount, redactForLog} from "@mapae/shared";

// The shared outermost budget — 15s here previously inverted the four-layer stack.
const REQUEST_TIMEOUT_MS = AGENT_REQUEST_TIMEOUT_MS;

/**
 * 한도 한 줄. 온체인 caveat 하나만 적던 문장은 이제 사실의 일부만 말한다 — 운영자가
 * env로 얹은 세 한도가 그 위에 있고, 그중 하나에 걸린 거절은 체인을 봐서는 설명되지
 * 않는다(`mapae_status`의 `limits`가 같은 사실을 구조화해서 보낸다).
 *
 * 미설정 한도는 적지 않는다. `unset`을 세 번 찍어 봐야 아래 한 줄이 말하는 것과 같고,
 * 체인 caveat은 어느 경우에도 남는 한도이므로 마지막에 항상 온다.
 */
function describeSpendLimits(policy: AgentSpendPolicy): string {
    const bounds = [
        policy.maxPerPaymentBase === undefined
            ? undefined
            : `per payment ≤ ${fromTokenAmount(policy.maxPerPaymentBase)} mUSDC`,
        policy.maxSessionTotalBase === undefined
            ? undefined
            : `session ≤ ${fromTokenAmount(policy.maxSessionTotalBase)} mUSDC`,
        policy.allowedPayTo === undefined
            ? undefined
            : `payTo in {${policy.allowedPayTo.join(", ")}}`,
    ].filter((bound): bound is string => bound !== undefined);
    bounds.push("parent erc20PeriodTransfer caveat");
    return bounds.join(" · ");
}

async function main(): Promise<void> {
    const runtime = await loadDelegatedAgentRuntime();
    const target = resolveResourceTarget(
        runtime.sellerUrl,
        process.argv[2] ?? "/s/demo-cafe/americano",
    );

    console.log(`delegated agent ${runtime.account.address}`);
    console.log(`target          ${target}`);
    console.log(`limit           ${describeSpendLimits(runtime.spendPolicy)}`);

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
