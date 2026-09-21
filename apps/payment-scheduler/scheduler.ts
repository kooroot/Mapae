import {payForDelegatedResource, resolveResourceTarget, type DelegatedAgentRuntime, type DelegatedPaymentFailureCode} from "@mapae/delegation";
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
/**
 * 결제 헤더가 이 프로세스를 떠나기 전에 끝난 실패들. 자금은 불변이므로 `unpaid`다.
 *
 * `DelegatedPaymentFailureCode`로 타이핑해 둔 것은 여기 적히는 이름이 실제 코드라는
 * 것만 컴파일러가 붙들게 하기 위한 것이다. 새 코드가 유니온에 생겼을 때 이 목록에
 * 들어가야 하는지는 타입이 대신 물어 주지 않는다 — `SPEND_POLICY_REFUSED`(서명 전
 * 정책 거절)가 누락된 채 `unknown`, 즉 "청구됐을 수 있음"으로 기록되던 것이 그
 * 증거다. 코드를 더하는 쪽이 이 줄을 같이 본다.
 */
const PRE_HEADER_FAILURES: DelegatedPaymentFailureCode[] = ["NOT_PAYMENT_REQUIRED", "UNSUPPORTED_X402_VERSION", "SELLER_OFFER_INVALID", "FACILITATOR_UNTRUSTED", "MANAGER_MISMATCH", "SPEND_POLICY_REFUSED", "LIMIT_EXCEEDED", "PERMISSION_INACTIVE", "PERMISSION_EMPTY", "SIGNING_FAILED"];

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
        if (PRE_HEADER_FAILURES.includes(result.code)) {
            return {outcome: "unpaid", code: result.code, retry: false};
        }
        return {outcome: "unknown", code: result.code};
    };
}
