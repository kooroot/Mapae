import {describe, expect, test} from "bun:test";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {decodeDelegations, encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {buildErc7710PaymentRequirements, MOCK_USDC, toTokenAmount} from "@mapae/shared";
import {getAddress, hexToBigInt, size, slice, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {ENTRY_POINT_V07} from "./config.js";
import {buildD3Policies, preparePeriodDelegation, withDelegationSignature} from "./policy.js";
import {createMapaeDelegationProvider} from "./x402.js";

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);

const PERIOD_ENFORCER = address(5);
const TRANSFER_AMOUNT_ENFORCER = address(6);
const ALLOWED_CALLDATA_ENFORCER = address(7);
const TIMESTAMP_ENFORCER = address(8);
const REDEEMER_ENFORCER = address(9);
const VALUE_LTE_ENFORCER = address(4);

const environment: SmartAccountsEnvironment = {
    DelegationManager: address(1),
    EntryPoint: ENTRY_POINT_V07,
    SimpleFactory: address(2),
    implementations: {HybridDeleGatorImpl: address(3)},
    caveatEnforcers: {
        ValueLteEnforcer: VALUE_LTE_ENFORCER,
        ERC20PeriodTransferEnforcer: PERIOD_ENFORCER,
        ERC20TransferAmountEnforcer: TRANSFER_AMOUNT_ENFORCER,
        AllowedCalldataEnforcer: ALLOWED_CALLDATA_ENFORCER,
        TimestampEnforcer: TIMESTAMP_ENFORCER,
        RedeemerEnforcer: REDEEMER_ENFORCER,
    },
};

/**
 * `DelegationManager.ANY_DELEGATE` — the framework's own sentinel, defined at
 * DelegationManager.sol:41 as "Allows any delegate to redeem the delegation".
 * Line 156 skips the caller check entirely when a delegation carries it.
 */
const ANY_DELEGATE = getAddress("0x0000000000000000000000000000000000000a11");

const PAYER = address(0x99);
const VENDOR = address(0x20);
const FACILITATOR = address(0x30);
const OTHER_FACILITATOR = address(0x31);
const session = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);

function parentContext(): Hex {
    const root = preparePeriodDelegation({
        environment,
        delegator: PAYER,
        delegate: session.address,
        policy: buildD3Policies(VENDOR)["open-agent"],
        startDate: 2_000_000_000,
    });
    // The parent's own signature is irrelevant here: this file is about what the
    // agent mints beneath it, and the chain is verified on-chain, not locally.
    return encodeDelegations([withDelegationSignature(root, `0x${"11".repeat(65)}` as Hex)]);
}

async function mintLeaf(facilitators: Address[] = [FACILITATOR], amount = 1_000_000n) {
    const provider = createMapaeDelegationProvider({
        account: session,
        environment,
        parentPermissionContext: parentContext(),
        facilitatorAddresses: facilitators,
    });
    const requirements = buildErc7710PaymentRequirements({
        payTo: VENDOR,
        amount,
        facilitatorAddresses: facilitators,
    });
    return decodeDelegations((await provider(requirements)).permissionContext);
}

/** Trusts `FACILITATOR`, but the seller's 402 advertises `advertised`. */
async function mintLeafAdvertising(advertised: Address[]) {
    const provider = createMapaeDelegationProvider({
        account: session,
        environment,
        parentPermissionContext: parentContext(),
        facilitatorAddresses: [FACILITATOR],
    });
    return provider(
        buildErc7710PaymentRequirements({
            payTo: VENDOR,
            amount: 1_000_000n,
            facilitatorAddresses: advertised,
        }),
    );
}

function termsFor(
    caveats: readonly {enforcer: string; terms: Hex}[],
    enforcer: Address,
): Hex | undefined {
    return caveats.find((caveat) => getAddress(caveat.enforcer) === enforcer)?.terms;
}

describe("the per-payment leaf the agent mints", () => {
    test("is redeemable by anyone as far as the DelegationManager is concerned", async () => {
        const [leaf] = await mintLeaf();

        // This is the fact that makes every assertion below load-bearing. The leaf
        // does NOT name the facilitator as its delegate; it carries ANY_DELEGATE, so
        // the manager performs no caller check at all. A signed X-PAYMENT header is
        // therefore only as safe as the RedeemerEnforcer caveat asserted next.
        expect(getAddress(leaf!.delegate)).toBe(ANY_DELEGATE);
    });

    test("pins the redeemer to exactly the configured facilitators", async () => {
        const [leaf] = await mintLeaf([FACILITATOR, OTHER_FACILITATOR]);
        const terms = termsFor(leaf!.caveats, REDEEMER_ENFORCER);

        // Combined with ANY_DELEGATE above, this caveat is the only thing standing
        // between a signed X-PAYMENT header and anyone who observes it.
        expect(terms).toBeDefined();
        expect(size(terms!)).toBe(40); // two 20-byte addresses, nothing else
        expect(getAddress(slice(terms!, 0, 20))).toBe(FACILITATOR);
        expect(getAddress(slice(terms!, 20, 40))).toBe(OTHER_FACILITATOR);
    });

    test("refuses to mint when the seller names a facilitator we do not trust", async () => {
        // The redeemer set is the intersection of what we configured and what the
        // seller advertised. An empty intersection must fail closed: minting with no
        // redeemer constraint would produce exactly the bearer token described above.
        // `payment-client` also rejects this earlier as FACILITATOR_UNTRUSTED — this
        // asserts the signing layer does not depend on that check having run.
        await expect(mintLeafAdvertising([OTHER_FACILITATOR])).rejects.toThrow(
            "No valid redeemer addresses were resolved",
        );
    });

    test("refuses to mint when the seller advertises no facilitator at all", async () => {
        await expect(mintLeafAdvertising([])).rejects.toThrow(
            "No valid redeemer addresses were resolved",
        );
    });

    test("pins the token and the amount of this one payment", async () => {
        const amount = toTokenAmount("2.5");
        const [leaf] = await mintLeaf([FACILITATOR], amount);
        const terms = termsFor(leaf!.caveats, TRANSFER_AMOUNT_ENFORCER);

        expect(terms).toBeDefined();
        expect(size(terms!)).toBe(52); // 20-byte token + 32-byte amount
        expect(getAddress(slice(terms!, 0, 20))).toBe(MOCK_USDC.address);
        expect(hexToBigInt(slice(terms!, 20, 52))).toBe(amount);
    });

    test("pins the recipient inside the transfer calldata", async () => {
        const [leaf] = await mintLeaf();
        const terms = termsFor(leaf!.caveats, ALLOWED_CALLDATA_ENFORCER);

        expect(terms).toBeDefined();
        // [32-byte offset into calldata][32-byte expected value]; the value is the
        // left-padded recipient, so a leaf cannot be replayed toward another payee.
        expect(size(terms!)).toBe(64);
        expect(getAddress(slice(terms!, 44, 64))).toBe(VENDOR);
    });

    test("forbids moving native value and carries an expiry", async () => {
        const [leaf] = await mintLeaf();

        const value = termsFor(leaf!.caveats, VALUE_LTE_ENFORCER);
        expect(value).toBeDefined();
        expect(hexToBigInt(value!)).toBe(0n);

        const timestamp = termsFor(leaf!.caveats, TIMESTAMP_ENFORCER);
        expect(timestamp).toBeDefined();
        expect(size(timestamp!)).toBe(32); // notBefore + notAfter, 16 bytes each
        expect(hexToBigInt(slice(timestamp!, 16, 32))).toBeGreaterThan(0n); // notAfter set
    });

    test("keeps the signed parent beneath it rather than replacing it", async () => {
        const chain = await mintLeaf();

        // The cap lives on the parent; a leaf that dropped it would be authority
        // the owner never granted.
        expect(chain).toHaveLength(2);
        expect(getAddress(chain[1]!.delegator)).toBe(PAYER);
        expect(getAddress(chain[1]!.delegate)).toBe(session.address);
        expect(chain[1]!.caveats.some((c) => getAddress(c.enforcer) === PERIOD_ENFORCER)).toBe(
            true,
        );
    });

    test("refuses to build a provider with no redeemer to pin", async () => {
        expect(() =>
            createMapaeDelegationProvider({
                account: session,
                environment,
                parentPermissionContext: parentContext(),
                facilitatorAddresses: [],
            }),
        ).toThrow("at least one facilitator redeemer address is required");
    });
});
