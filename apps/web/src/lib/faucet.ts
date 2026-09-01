import {FAUCET_TARGET_BASE} from "@mapae/delegation/faucet-policy";
import {fromTokenAmount} from "@mapae/shared";
import type {Delegation} from "@metamask/smart-accounts-kit";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {postBootstrap, type BootstrapReply} from "./grant";
import type {Locale} from "./i18n";

/**
 * The testnet top-up, as the Studio sees it.
 *
 * The sponsor's bootstrap endpoint is the faucet: a request for an account that already
 * exists tops it up to the target once per account per day. This module turns that reply
 * into one of five outcomes and the sentence to show for each. The "once per day" refusal
 * is an outcome, not an error — it is the policy working, and a person who reads it as a
 * failure will retry until it is one.
 *
 * Copy rule: the token is always "tUSDC (testnet, not real money)", never the bare ticker.
 * The wallet shows a dollar sign, and nobody reading fast should have to wonder.
 */
export type TopUpOutcome =
    | {kind: "minted"; amount: bigint; transaction?: string}
    | {kind: "at_target"; target: bigint}
    | {kind: "faucet_off"}
    | {kind: "recently_used"}
    | {kind: "refused"; reason?: string};

/** The sponsor authorises on the signed root alone: a chain of one, never the agent's leaf. */
export function topUpPermissionContext(root: Delegation): `0x${string}` {
    return encodeDelegations([root]);
}

const BASE_UNITS = /^(0|[1-9]\d*)$/;

export function interpretTopUp(reply: {ok: boolean; body: BootstrapReply}): TopUpOutcome {
    const {ok, body} = reply;
    if (!ok) {
        return body.reason === "faucet_recently_used"
            ? {kind: "recently_used"}
            : {kind: "refused", reason: body.reason};
    }
    const mintedBase = body.mintedBase ?? "";
    const targetBase = body.targetBase ?? "";
    if (!BASE_UNITS.test(mintedBase) || !BASE_UNITS.test(targetBase)) {
        // A success without the amounts is a reply this client was not written against.
        return {kind: "refused"};
    }
    const minted = BigInt(mintedBase);
    const target = BigInt(targetBase);
    if (target === 0n) return {kind: "faucet_off"};
    if (minted > 0n) {
        return body.fundingTransaction === undefined
            ? {kind: "minted", amount: minted}
            : {kind: "minted", amount: minted, transaction: body.fundingTransaction};
    }
    return {kind: "at_target", target};
}

export const TESTNET_TOKEN: Record<Locale, string> = {
    en: "tUSDC (testnet, not real money)",
    ko: "tUSDC (테스트넷, 실제 돈 아님)",
};

export const FAUCET_COPY: Record<
    Locale,
    {
        action: string;
        busy: string;
        hint: string;
        minted: (amount: string) => string;
        atTarget: (target: string) => string;
        faucetOff: string;
        recentlyUsed: string;
        budgetExhausted: string;
        feeTooHigh: string;
        failed: string;
        viewTransaction: string;
    }
> = {
    en: {
        action: "Get testnet balance",
        busy: "Requesting…",
        hint: `Tops this payer account up to ${fromTokenAmount(FAUCET_TARGET_BASE)} ${TESTNET_TOKEN.en}, once per account per day.`,
        minted: (amount) => `Received ${amount} ${TESTNET_TOKEN.en}.`,
        atTarget: (target) =>
            `This account already holds ${target} ${TESTNET_TOKEN.en} or more — nothing to add.`,
        faucetOff: "The testnet faucet is turned off right now.",
        recentlyUsed:
            "This account already received testnet balance in the last 24 hours. Try again tomorrow.",
        budgetExhausted: "Today's sponsored gas has been used up. Try again tomorrow.",
        feeTooHigh: "Network fees are temporarily high. Try again in a moment.",
        failed: "The testnet balance could not be added.",
        viewTransaction: "View transaction",
    },
    ko: {
        action: "테스트넷 잔액 받기",
        busy: "요청 중…",
        hint: `이 지불 계정의 잔액을 ${fromTokenAmount(FAUCET_TARGET_BASE)} ${TESTNET_TOKEN.ko}까지 채웁니다. 계정당 하루 한 번.`,
        minted: (amount) => `${amount} ${TESTNET_TOKEN.ko}를 받았습니다.`,
        atTarget: (target) =>
            `이 계정은 이미 ${target} ${TESTNET_TOKEN.ko} 이상을 갖고 있어 더 받을 것이 없습니다.`,
        faucetOff: "테스트넷 faucet이 지금은 꺼져 있습니다.",
        recentlyUsed:
            "이 계정은 최근 24시간 안에 테스트넷 잔액을 이미 받았습니다. 내일 다시 시도해 주세요.",
        budgetExhausted: "오늘 대납 가능한 가스를 모두 썼습니다. 내일 다시 시도해 주세요.",
        feeTooHigh: "네트워크 수수료가 일시적으로 높습니다. 잠시 후 다시 시도해 주세요.",
        failed: "테스트넷 잔액을 받지 못했습니다.",
        viewTransaction: "트랜잭션 보기",
    },
};

export function topUpMessage(outcome: TopUpOutcome, locale: Locale): string {
    const t = FAUCET_COPY[locale];
    switch (outcome.kind) {
        case "minted":
            return t.minted(fromTokenAmount(outcome.amount));
        case "at_target":
            return t.atTarget(fromTokenAmount(outcome.target));
        case "faucet_off":
            return t.faucetOff;
        case "recently_used":
            return t.recentlyUsed;
        case "refused":
            switch (outcome.reason) {
                case "bootstrap_disabled":
                    return t.faucetOff;
                case "budget_exhausted":
                case "sponsor_unfunded":
                    return t.budgetExhausted;
                case "fee_too_high":
                    return t.feeTooHigh;
                default:
                    return t.failed;
            }
    }
}

export async function requestTestnetTopUp(params: {
    endpoint: string;
    root: Delegation;
    locale: Locale;
}): Promise<TopUpOutcome> {
    const reply = await postBootstrap(
        params.endpoint,
        topUpPermissionContext(params.root),
        params.locale,
    );
    return interpretTopUp(reply);
}
