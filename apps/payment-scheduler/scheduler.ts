import {payForDelegatedResource, resolveResourceTarget, type DelegatedAgentRuntime} from "@mapae/delegation";
import type {ScheduleStore, ScheduledJob, ScheduledResult} from "@mapae/store";

/** Each claimed job is paused until a known result is committed. No startup lease or replay is needed. */
export async function tick(store: ScheduleStore, execute: (job: ScheduledJob) => Promise<ScheduledResult>, now = Date.now): Promise<number> {
    let count = 0;
    for (const job of store.list()) {
        const claimed = store.claim(job.id, now());
        if (!claimed) continue;
        count++;
        let result: ScheduledResult;
        try {result = await execute(claimed.job);} catch {result = {outcome: "unknown", code: "EXECUTION_INTERRUPTED"};}
        store.finish(claimed.run.id, result, now());
    }
    return count;
}
export function paymentExecutor(store: ScheduleStore, runtime: Pick<DelegatedAgentRuntime, "sellerUrl" | "delegationManager" | "trustedFacilitators" | "preflight" | "provider">, now = Date.now, fetchImpl?: typeof fetch) {
    return async (job: ScheduledJob): Promise<ScheduledResult> => {
        let policyDenied = false;
        const allowed = () => store.get(job.id)?.status !== "cancelled" && now() < job.endsAt;
        const result = await payForDelegatedResource(resolveResourceTarget(runtime.sellerUrl, job.resourcePath), {
            delegationManager: runtime.delegationManager, trustedFacilitators: runtime.trustedFacilitators,
            preflight: runtime.preflight, fetchImpl,
            provider: async (offer) => {
                if (!allowed() || offer.payTo.toLowerCase() !== job.payTo.toLowerCase() || BigInt(offer.amount) > job.maxAmountBase) {
                    policyDenied = true; throw new Error("schedule condition refused");
                }
                const signed = await runtime.provider(offer);
                if (!allowed()) {policyDenied = true; throw new Error("schedule cancelled or expired while signing");}
                return signed;
            },
        });
        if (result.ok) return {outcome: "paid", amountBase: BigInt(result.amount), transaction: result.transaction};
        if (policyDenied) return {outcome: "unpaid", code: "POLICY_DENIED", retry: false};
        if (result.code === "TRANSPORT_ERROR" || result.code === "SELLER_UNAVAILABLE") return {outcome: "unpaid", code: result.code, retry: true};
        // These failures happen before a payment header can leave this process.
        if (["NOT_PAYMENT_REQUIRED", "UNSUPPORTED_X402_VERSION", "SELLER_OFFER_INVALID", "FACILITATOR_UNTRUSTED", "MANAGER_MISMATCH", "LIMIT_EXCEEDED", "PERMISSION_INACTIVE", "PERMISSION_EMPTY", "SIGNING_FAILED"].includes(result.code)) {
            return {outcome: "unpaid", code: result.code, retry: false};
        }
        return {outcome: "unknown", code: result.code};
    };
}
