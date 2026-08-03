/**
 * 정산 한 건이 이 제품의 주장을 실제로 증명하는지 판정한다.
 *
 * 트랜잭션이 성공했다는 것과 데모의 주장이 참이라는 것은 다른 문장이다. `status: success`인
 * 영수증은 잘못된 금액이 잘못된 주소로 갔어도, payer가 자기 가스를 냈어도 똑같이 성공이다.
 * 그래서 판정은 영수증이 아니라 **전후 체인 상태의 차이**에서 나온다 — 정산 경로가 스스로
 * 보고한 값이 아니라, 그 경로 바깥에서 독립적으로 읽은 값이다.
 *
 * 스크립트의 `main()` 안이 아니라 여기 있는 이유는 하나다. 아래 네 검사 중 세 번째가 조용히
 * 뒤집히면 payer가 가스를 낸 실행도 PASS로 보고되고, 그것은 이 제품의 중심 주장이 거짓인
 * 채로 통과했다는 뜻이다. 체인과 서비스 세 개가 떠 있어야만 도달하는 코드는 아무도 테스트하지
 * 않는다.
 */

import {keccak256, toBytes} from "viem";

/** 정산 전후 각각 한 번씩 읽는, 서로 독립된 네 관측값. */
export interface SettlementSnapshot {
    /** 위임으로 대금을 낸 계정의 토큰 잔고. */
    payerToken: bigint;
    /** 같은 계정의 네이티브 잔고. 가스리스는 이 값에 대해 주장된다. */
    payerNative: bigint;
    /** 402가 수취인으로 지목한 주소의 토큰 잔고. */
    vendorToken: bigint;
    /** 정산을 브로드캐스트한 계정의 트랜잭션 수. */
    relayerNonce: number;
}

export type SettlementDiscrepancyCode =
    | "PAYER_DEBIT"
    | "VENDOR_CREDIT"
    | "PAYER_PAID_GAS"
    | "RELAYER_NONCE";

export interface SettlementDiscrepancy {
    code: SettlementDiscrepancyCode;
    detail: string;
}

/**
 * 전후 상태를 대조해 어긋난 항목을 돌려준다. 빈 배열이면 이 정산은 증거로 성립한다.
 *
 * 네 검사는 서로를 대신하지 못한다. payer가 줄었다는 것만으로는 대금이 판매자에게 갔다는
 * 보장이 없고(중간에서 샐 수 있다), 판매자가 늘었다는 것만으로는 그 돈이 이 payer에게서
 * 나왔다는 보장이 없다. 둘을 각각 확인해야 "이 계정에서 저 계정으로, 정확히 이 금액"이 된다.
 *
 * 금액은 정확히 일치해야 한다. 부등호로 느슨하게 두면 caveat이 허용하는 한도 안에서 청구된
 * 금액보다 더 큰 이체가 지나가도 통과한다 — 한도가 상한일 뿐 청구액이 아니라는 점이 바로
 * 이 대조가 존재하는 이유다.
 */
export function reconcileSettlement(params: {
    before: SettlementSnapshot;
    after: SettlementSnapshot;
    /** 402가 청구한 금액. 최소 단위(mUSDC는 6 decimals). */
    amount: bigint;
    /** 대금을 낸 계정. vendor와 같으면 대조 자체가 성립하지 않는다. */
    payer?: string;
    /** 402가 지목한 수취인. */
    vendor?: string;
}): SettlementDiscrepancy[] {
    const {before, after, amount} = params;

    if (amount <= 0n) {
        // 0원 정산은 아래 네 검사를 아무 일도 일어나지 않은 상태에 대해 전부 통과시킨다.
        // 증거가 되지 못하는 입력은 판정하지 않고 거부한다.
        throw new Error("reconcileSettlement needs a positive amount");
    }
    if (params.payer && params.vendor && params.payer.toLowerCase() === params.vendor.toLowerCase()) {
        // 자기 자신에게 보내면 payer 감소와 vendor 증가가 서로를 상쇄해 두 검사가 동시에
        // 참일 수 없다. 판정 불가를 "불일치"로 보고하면 원인을 엉뚱한 데서 찾게 된다.
        throw new Error("payer and vendor are the same address — this settlement cannot be reconciled");
    }

    const problems: SettlementDiscrepancy[] = [];

    const payerDelta = after.payerToken - before.payerToken;
    if (payerDelta !== -amount) {
        problems.push({
            code: "PAYER_DEBIT",
            detail: `payer token balance moved ${payerDelta}, expected ${-amount}`,
        });
    }

    const vendorDelta = after.vendorToken - before.vendorToken;
    if (vendorDelta !== amount) {
        problems.push({
            code: "VENDOR_CREDIT",
            detail: `vendor token balance moved ${vendorDelta}, expected ${amount}`,
        });
    }

    // 이 데모의 중심 주장. payer는 GIWA ETH를 한 푼도 갖지 않도록 설계돼 있고, 정산 가스는
    // relayer가 전부 낸다. 정확히 같아야 한다 — 줄지 않았다는 것으로는 부족하고, 늘어난
    // 것도 이 실행이 설명하지 못하는 사건이다.
    if (after.payerNative !== before.payerNative) {
        const moved = after.payerNative - before.payerNative;
        problems.push({
            code: "PAYER_PAID_GAS",
            detail: `payer native balance moved ${moved}, expected 0 — the payer must never fund gas`,
        });
    }

    // 정확히 1. 0이면 아무것도 브로드캐스트되지 않았고(정산이 다른 경로로 갔다는 뜻),
    // 2 이상이면 이 창 안에서 relayer가 다른 일도 했다는 뜻이라 위 잔고 차이를 이 결제
    // 하나로 귀속시킬 수 없다. 어느 쪽이든 증거로는 실패다.
    const nonceDelta = after.relayerNonce - before.relayerNonce;
    if (nonceDelta !== 1) {
        problems.push({
            code: "RELAYER_NONCE",
            detail:
                `relayer nonce moved ${nonceDelta}, expected 1` +
                (nonceDelta > 1 ? " — another transaction shared this window" : ""),
        });
    }

    return problems;
}

/** `Transfer(address,address,uint256)`의 topic0. 상수 리터럴 대신 계산해 오타 여지를 없앤다. */
export const TRANSFER_EVENT_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));

/** 영수증 로그의 필요한 면만 본다 — viem `Log`와 구조적으로 호환. */
export interface ReceiptLog {
    address: string;
    topics: readonly string[];
    data: string;
}

/**
 * 위의 스냅샷 대조(reconcileSettlement)의 프로덕션 등가물. 스냅샷 대조는 전후 두 번의 읽기
 * 사이에 다른 이체가 끼어들 수 없는 실험실 창을 전제하지만, facilitator의 정산 경로에는 그런
 * 창이 없다. 트랜잭션 **자기 영수증의 로그**는 그 창 문제가 없다 — 이 트랜잭션이 낸 사건만
 * 담기므로, 동시성이 있어도 귀속이 흔들리지 않는다.
 *
 * 존재 이유는 감사 지적 그대로다: enforcer는 calldata를 제약하고 allowance를 소모하지만
 * **수취인 잔액이 늘었다는 것은 증명하지 않는다.** revert 없이 `false`를 반환하는 토큰이면
 * redeemDelegations는 호출로서 성공하고 영수증 status도 "success"인데 자금은 움직이지 않는다.
 * 그 경우 유일한 흔적은 Transfer 이벤트의 **부재**이고, 이 판정이 그것을 잡는다.
 *
 * 정확히 1건을 요구한다. 0건이면 위의 케이스이고, 2건 이상이면 이 결제 하나로 귀속할 수 없는
 * 실행이다(청구액의 배수가 움직였다는 뜻이므로 통과가 아니라 실패다). 금액도 정확히 일치해야
 * 한다 — 스냅샷 대조와 같은 이유로, 한도는 상한일 뿐 청구액이 아니다.
 *
 * 한계도 명시한다: 이벤트는 토큰 컨트랙트의 주장이다. 이벤트에 적힌 금액과 다르게 잔고를
 * 움직이는 병적인 토큰(fee-on-transfer 등)은 이 판정 밖이며, 그런 토큰을 자산으로 받을지는
 * 별도의 토큰 거동 리뷰가 정한다. MockUSDC(OZ ERC20)는 이벤트와 잔고가 일치한다.
 */
export function reconcileSettlementReceipt(params: {
    logs: readonly ReceiptLog[];
    asset: string;
    payer: string;
    payTo: string;
    amount: bigint;
}): SettlementDiscrepancy[] {
    const asset = params.asset.toLowerCase();
    const expectedFrom = padTopicAddress(params.payer);
    const expectedTo = padTopicAddress(params.payTo);

    const matches = params.logs.filter(
        (log) =>
            log.address.toLowerCase() === asset &&
            log.topics[0]?.toLowerCase() === TRANSFER_EVENT_TOPIC &&
            log.topics[1]?.toLowerCase() === expectedFrom &&
            log.topics[2]?.toLowerCase() === expectedTo,
    );

    if (matches.length !== 1) {
        return [
            {
                code: "VENDOR_CREDIT",
                detail:
                    `receipt carries ${matches.length} Transfer(payer → payTo) events on the asset, expected exactly 1` +
                    (matches.length === 0
                        ? " — a token returning false instead of reverting leaves exactly this trace"
                        : ""),
            },
        ];
    }

    const moved = BigInt(matches[0]!.data);
    if (moved !== params.amount) {
        return [
            {
                code: "VENDOR_CREDIT",
                detail: `receipt Transfer moved ${moved}, the 402 charged ${params.amount}`,
            },
        ];
    }
    return [];
}

function padTopicAddress(address: string): string {
    return `0x000000000000000000000000${address.slice(2).toLowerCase()}`;
}
