import type {Address, Hex, TypedDataDomain} from "viem";
import {giwaSepolia} from "./chain.js";

/**
 * MockUSDC — EIP-3009 test stablecoin deployed for Mapae.
 *
 * ⚠️ `eip712.name` and `eip712.version` MUST match the deployed contract byte for byte.
 *    The seller advertises them in the 402 `extra` field; the agent signs against them.
 *    A single character of drift makes every signature fail verification.
 *    Verify against the contract's `eip712Domain()` (ERC-5267) if in doubt.
 */
export const MOCK_USDC = {
    address: "0xcfeb694719A09caeb80798e2011298F29CDa4e92" as Address,
    symbol: "mUSDC",
    decimals: 6,
    eip712: {
        name: "Mock USDC",
        version: "2",
    },
} as const;

/** EIP-3009 typed-data definitions. Field order is part of the type hash — do not reorder. */
export const EIP3009_TYPES = {
    TransferWithAuthorization: [
        {name: "from", type: "address"},
        {name: "to", type: "address"},
        {name: "value", type: "uint256"},
        {name: "validAfter", type: "uint256"},
        {name: "validBefore", type: "uint256"},
        {name: "nonce", type: "bytes32"},
    ],
    ReceiveWithAuthorization: [
        {name: "from", type: "address"},
        {name: "to", type: "address"},
        {name: "value", type: "uint256"},
        {name: "validAfter", type: "uint256"},
        {name: "validBefore", type: "uint256"},
        {name: "nonce", type: "bytes32"},
    ],
    CancelAuthorization: [
        {name: "authorizer", type: "address"},
        {name: "nonce", type: "bytes32"},
    ],
} as const;

/** The authorization struct the payer signs. */
export interface TransferAuthorization {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
}

/** Minimal ABI surface the apps actually call. */
export const MOCK_USDC_ABI = [
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{name: "account", type: "address"}],
        outputs: [{type: "uint256"}],
    },
    {
        type: "function",
        name: "decimals",
        stateMutability: "pure",
        inputs: [],
        outputs: [{type: "uint8"}],
    },
    {
        type: "function",
        name: "authorizationState",
        stateMutability: "view",
        inputs: [
            {name: "authorizer", type: "address"},
            {name: "nonce", type: "bytes32"},
        ],
        outputs: [{type: "bool"}],
    },
    {
        type: "function",
        name: "DOMAIN_SEPARATOR",
        stateMutability: "view",
        inputs: [],
        outputs: [{type: "bytes32"}],
    },
    {
        type: "function",
        name: "mint",
        stateMutability: "nonpayable",
        inputs: [
            {name: "to", type: "address"},
            {name: "value", type: "uint256"},
        ],
        outputs: [],
    },
] as const;

/**
 * 1.5 → 1500000n.
 *
 * Reject excess precision instead of truncating it: silently turning 1.0000009 into
 * 1.000000 is unsafe for a payment limit and makes configuration mistakes invisible.
 */
export function toTokenAmount(human: string): bigint {
    const normalized = human.trim();
    const pattern = new RegExp(`^(0|[1-9]\\d*)(?:\\.(\\d{1,${MOCK_USDC.decimals}}))?$`);
    const match = normalized.match(pattern);
    if (!match) {
        throw new Error(
            `invalid ${MOCK_USDC.symbol} amount "${human}" — expected a non-negative decimal ` +
                `with at most ${MOCK_USDC.decimals} fractional digits`,
        );
    }

    const whole = match[1];
    const frac = match[2] ?? "";
    const padded = frac.padEnd(MOCK_USDC.decimals, "0").slice(0, MOCK_USDC.decimals);
    return BigInt(whole + padded);
}

/** 1500000n → "1.50" */
export function fromTokenAmount(raw: bigint): string {
    const base = 10n ** BigInt(MOCK_USDC.decimals);
    const whole = raw / base;
    const frac = (raw % base).toString().padStart(MOCK_USDC.decimals, "0");
    return `${whole}.${frac.replace(/0+$/, "") || "0"}`;
}
