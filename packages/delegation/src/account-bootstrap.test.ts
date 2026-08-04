import {describe, expect, test} from "bun:test";
import {
    concatHex,
    getAddress,
    keccak256,
    encodeAbiParameters,
    encodePacked,
    parseAbiParameters,
    toHex,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {
    Implementation,
    type Delegation,
    type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {
    encodeDelegations,
    getCounterfactualAccountData,
} from "@metamask/smart-accounts-kit/utils";
import {giwaSepolia} from "@mapae/shared";
import {ENTRY_POINT_V07, OWNER_ACCOUNT_SALT} from "./config.js";
import {buildD3Policies, preparePeriodDelegation, withDelegationSignature} from "./policy.js";
import {buildRootDelegationTypedData} from "./signing.js";
import {
    FixedWindowLimiter,
    SPONSORED_BOOTSTRAP_APPROVAL_PREFIX,
    SpendBudget,
    buildSponsoredBootstrapApproval,
    costOfReceipt,
    isCanonicalSignature,
    parseBootstrapOrigins,
    readReceiptFeeField,
    validateAccountBootstrap,
    type AccountBootstrapPolicy,
} from "./account-bootstrap.js";
import {FRAMEWORK_COMPOSITION_ID} from "./composition.js";

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);

/**
 * A real deployed framework shape. `SimpleFactory` and `HybridDeleGatorImpl` must be
 * plausible addresses because the validator derives a CREATE2 address from them; the
 * enforcer addresses only need to be distinct so membership can be asserted.
 */
const environment: SmartAccountsEnvironment = {
    DelegationManager: address(0x11),
    EntryPoint: ENTRY_POINT_V07,
    SimpleFactory: address(0x22),
    implementations: {HybridDeleGatorImpl: address(0x33)},
    caveatEnforcers: {
        ValueLteEnforcer: address(0x41),
        ERC20PeriodTransferEnforcer: address(0x42),
        ERC20TransferAmountEnforcer: address(0x43),
        AllowedCalldataEnforcer: address(0x44),
        TimestampEnforcer: address(0x45),
        RedeemerEnforcer: address(0x46),
    },
};

const OWNER_KEY = `0x${"11".repeat(32)}` as Hex;
const owner = privateKeyToAccount(OWNER_KEY);
const AGENT = address(0x51);
const VENDOR = address(0x52);
const START = 2_000_000_000;

const policies = buildD3Policies(VENDOR);

const policy: AccountBootstrapPolicy = {
    environment,
    chainId: giwaSepolia.id,
    approval: buildSponsoredBootstrapApproval(FRAMEWORK_COMPOSITION_ID),
};

async function counterfactual(accountOwner: Address) {
    return getCounterfactualAccountData({
        factory: getAddress(environment.SimpleFactory),
        implementations: environment.implementations,
        implementation: Implementation.Hybrid,
        deployParams: [accountOwner, [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });
}

/** Build a signed root delegation exactly as Studio's offline path produces it. */
async function signedRoot(overrides?: {
    delegator?: Address;
    delegate?: Address;
    caveatEnforcer?: Address;
}): Promise<{delegation: Delegation; permissionContext: Hex; account: Address}> {
    const account = await counterfactual(owner.address);
    const delegator = overrides?.delegator ?? getAddress(account.address);
    const unsigned = preparePeriodDelegation({
        environment,
        delegator,
        delegate: overrides?.delegate ?? AGENT,
        policy: policies["open-agent"],
        startDate: START,
    });
    const mutated = overrides?.caveatEnforcer
        ? {
              ...unsigned,
              caveats: [
                  {...unsigned.caveats[0]!, enforcer: overrides.caveatEnforcer},
                  ...unsigned.caveats.slice(1),
              ],
          }
        : unsigned;
    const typedData = buildRootDelegationTypedData(environment.DelegationManager, mutated);
    const signature = await owner.signTypedData(typedData);
    const delegation = withDelegationSignature(mutated, signature);
    return {
        delegation,
        permissionContext: encodeDelegations([delegation]),
        account: getAddress(account.address),
    };
}

describe("buildSponsoredBootstrapApproval", () => {
    test("pins the approval phrase to chain and composition", () => {
        const phrase = buildSponsoredBootstrapApproval(FRAMEWORK_COMPOSITION_ID);
        expect(phrase).toBe(
            `${SPONSORED_BOOTSTRAP_APPROVAL_PREFIX}-chain-${giwaSepolia.id}-${FRAMEWORK_COMPOSITION_ID}`,
        );
    });

    test("a different composition yields a different phrase", () => {
        expect(buildSponsoredBootstrapApproval("other-composition")).not.toBe(
            buildSponsoredBootstrapApproval(FRAMEWORK_COMPOSITION_ID),
        );
    });
});

describe("isCanonicalSignature", () => {
    const lowS = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;

    test("accepts a low-s signature with v = 27", () => {
        expect(isCanonicalSignature(lowS)).toBe(true);
    });

    test("accepts v = 28", () => {
        expect(isCanonicalSignature((lowS.slice(0, -2) + "1c") as Hex)).toBe(true);
    });

    test("rejects v = 0 and v = 1 (compact recovery ids)", () => {
        expect(isCanonicalSignature((lowS.slice(0, -2) + "00") as Hex)).toBe(false);
        expect(isCanonicalSignature((lowS.slice(0, -2) + "01") as Hex)).toBe(false);
    });

    test("rejects high-s, which OZ ECDSA.recover reverts on", () => {
        // secp256k1n/2 + 1
        const highS = "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1";
        expect(isCanonicalSignature(`0x${"11".repeat(32)}${highS}1b` as Hex)).toBe(false);
    });

    test("accepts exactly secp256k1n/2 (the boundary is inclusive)", () => {
        const halfN = "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0";
        expect(isCanonicalSignature(`0x${"11".repeat(32)}${halfN}1b` as Hex)).toBe(true);
    });

    test("rejects a signature that is not 65 bytes", () => {
        expect(isCanonicalSignature(`0x${"11".repeat(64)}` as Hex)).toBe(false);
    });
});

describe("validateAccountBootstrap", () => {
    test("accepts a root signed by the owner of the derived account", async () => {
        const {permissionContext, account} = await signedRoot();
        const validated = await validateAccountBootstrap({permissionContext}, policy);

        expect(validated.account).toBe(account);
        expect(validated.owner).toBe(getAddress(owner.address));
        expect(validated.salt).toBe(OWNER_ACCOUNT_SALT);
        expect(validated.factoryTarget).toBe(getAddress(environment.SimpleFactory));
        expect(validated.factoryData.startsWith("0x")).toBe(true);
    });

    test("the derived factoryData deploys to exactly the validated account", async () => {
        const {permissionContext} = await signedRoot();
        const validated = await validateAccountBootstrap({permissionContext}, policy);

        // `deploy(bytes,bytes32)` — re-derive CREATE2 from the initcode the service will send.
        const [bytecode, salt] = decodeSimpleFactoryDeploy(validated.factoryData);
        expect(salt).toBe(OWNER_ACCOUNT_SALT);
        expect(create2Address(getAddress(environment.SimpleFactory), salt, bytecode)).toBe(
            validated.account,
        );
    });

    test("rejects a non-object request", async () => {
        await expect(validateAccountBootstrap(null, policy)).rejects.toThrow(
            "request must be an object",
        );
    });

    test("rejects a permissionContext that is not hex", async () => {
        await expect(
            validateAccountBootstrap({permissionContext: "not-hex"}, policy),
        ).rejects.toThrow("permissionContext");
    });

    test("rejects a permissionContext that does not decode", async () => {
        await expect(
            validateAccountBootstrap({permissionContext: "0xdeadbeef"}, policy),
        ).rejects.toThrow("not a delegation chain");
    });

    test("rejects a chain with a leaf attached — root only", async () => {
        const {delegation} = await signedRoot();
        const leaf: Delegation = {...delegation, delegate: address(0x77)};
        const twoLink = encodeDelegations([leaf, delegation]);
        await expect(
            validateAccountBootstrap({permissionContext: twoLink}, policy),
        ).rejects.toThrow("exactly one delegation");
    });

    test("rejects a signature that is not 65 bytes", async () => {
        const {delegation} = await signedRoot();
        const p256Shaped = withDelegationSignature(
            delegation,
            `0x${"cd".repeat(96)}` as Hex,
        );
        await expect(
            validateAccountBootstrap(
                {permissionContext: encodeDelegations([p256Shaped])},
                policy,
            ),
        ).rejects.toThrow("65-byte");
    });

    test("rejects a non-canonical (high-s) signature before spending anything", async () => {
        const {delegation} = await signedRoot();
        const highS = concatHex([
            delegation.signature.slice(0, 66) as Hex,
            "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1",
            "0x1b",
        ]);
        await expect(
            validateAccountBootstrap(
                {permissionContext: encodeDelegations([withDelegationSignature(delegation, highS)])},
                policy,
            ),
        ).rejects.toThrow("canonical");
    });

    test("refuses cleanly when a 65-byte signature is not a curve point", async () => {
        // Passes the canonical range check, but r/s describe no point — viem throws
        // "Point is not on curve". A public endpoint must answer with its own refusal,
        // never an internal crypto error.
        const {delegation} = await signedRoot();
        const random = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;
        await expect(
            validateAccountBootstrap(
                {permissionContext: encodeDelegations([withDelegationSignature(delegation, random)])},
                policy,
            ),
        ).rejects.toThrow("does not recover");
    });

    test("rejects a valid signature made by a key that does not own the delegator", async () => {
        // The attack this whole validator exists to stop: sign the message correctly, but
        // with your own key, and ask us to deploy someone else's account.
        const stranger = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);
        const victim = await counterfactual(owner.address);
        const unsigned = preparePeriodDelegation({
            environment,
            delegator: getAddress(victim.address),
            delegate: AGENT,
            policy: policies["open-agent"],
            startDate: START,
        });
        const signature = await stranger.signTypedData(
            buildRootDelegationTypedData(environment.DelegationManager, unsigned),
        );
        await expect(
            validateAccountBootstrap(
                {permissionContext: encodeDelegations([withDelegationSignature(unsigned, signature)])},
                policy,
            ),
        ).rejects.toThrow("does not own");
    });

    test("a stranger can still bootstrap their OWN account — the check is ownership, not identity", async () => {
        const stranger = privateKeyToAccount(`0x${"33".repeat(32)}` as Hex);
        const theirs = await counterfactual(stranger.address);
        const unsigned = preparePeriodDelegation({
            environment,
            delegator: getAddress(theirs.address),
            delegate: AGENT,
            policy: policies["open-agent"],
            startDate: START,
        });
        const signature = await stranger.signTypedData(
            buildRootDelegationTypedData(environment.DelegationManager, unsigned),
        );
        const validated = await validateAccountBootstrap(
            {permissionContext: encodeDelegations([withDelegationSignature(unsigned, signature)])},
            policy,
        );
        expect(validated.owner).toBe(getAddress(stranger.address));
        expect(validated.account).toBe(getAddress(theirs.address));
    });

    test("rejects a delegator that is not CREATE2 of the recovered owner", async () => {
        // Signed correctly, but the delegator names someone else's account.
        const {permissionContext} = await signedRoot({delegator: address(0x99)});
        await expect(
            validateAccountBootstrap({permissionContext}, policy),
        ).rejects.toThrow("does not own");
    });

    test("rejects a root signed for a different DelegationManager", async () => {
        const account = await counterfactual(owner.address);
        const unsigned = preparePeriodDelegation({
            environment,
            delegator: getAddress(account.address),
            delegate: AGENT,
            policy: policies["open-agent"],
            startDate: START,
        });
        const foreign = buildRootDelegationTypedData(address(0xbeef), unsigned);
        const signature = await owner.signTypedData(foreign);
        await expect(
            validateAccountBootstrap(
                {
                    permissionContext: encodeDelegations([
                        withDelegationSignature(unsigned, signature),
                    ]),
                },
                policy,
            ),
        ).rejects.toThrow("does not own");
    });

    test("rejects a caveat enforcer that is not in the deployment artifact", async () => {
        const {permissionContext} = await signedRoot({caveatEnforcer: address(0xdead)});
        await expect(
            validateAccountBootstrap({permissionContext}, policy),
        ).rejects.toThrow("not part of this deployment");
    });

    test("rejects a zero delegate", async () => {
        const {permissionContext} = await signedRoot({
            delegate: "0x0000000000000000000000000000000000000000",
        });
        await expect(
            validateAccountBootstrap({permissionContext}, policy),
        ).rejects.toThrow("delegate");
    });

    test("does not pin the policy shape — amount and period are the user's choice", async () => {
        const account = await counterfactual(owner.address);
        const unsigned = preparePeriodDelegation({
            environment,
            delegator: getAddress(account.address),
            delegate: AGENT,
            // A different role with a different amount must still bootstrap.
            policy: policies["team-manager"],
            startDate: START + 12_345,
        });
        const signature = await owner.signTypedData(
            buildRootDelegationTypedData(environment.DelegationManager, unsigned),
        );
        const validated = await validateAccountBootstrap(
            {permissionContext: encodeDelegations([withDelegationSignature(unsigned, signature)])},
            policy,
        );
        expect(validated.account).toBe(getAddress(account.address));
    });
});

describe("parseBootstrapOrigins", () => {
    test("falls back when unset or empty", () => {
        expect(parseBootstrapOrigins(undefined, ["https://app.mapae.io"])).toEqual([
            "https://app.mapae.io",
        ]);
        expect(parseBootstrapOrigins("   ", ["https://app.mapae.io"])).toEqual([
            "https://app.mapae.io",
        ]);
    });

    test("accepts a public HTTPS origin — unlike the loopback-only submitter list", () => {
        expect(parseBootstrapOrigins("https://app.mapae.io", [])).toEqual([
            "https://app.mapae.io",
        ]);
    });

    test("normalises a path and trailing slash down to the origin", () => {
        expect(parseBootstrapOrigins("https://app.mapae.io/studio/", [])).toEqual([
            "https://app.mapae.io",
        ]);
    });

    test("allows plain http only for loopback development", () => {
        expect(parseBootstrapOrigins("http://127.0.0.1:5173,http://localhost:4173", [])).toEqual([
            "http://127.0.0.1:5173",
            "http://localhost:4173",
        ]);
        expect(() => parseBootstrapOrigins("http://evil.example", [])).toThrow("HTTPS");
    });

    test("refuses the wildcard — this service fronts a funded key", () => {
        expect(() => parseBootstrapOrigins("*", [])).toThrow("must not be '*'");
    });

    test("refuses a non-URL entry", () => {
        expect(() => parseBootstrapOrigins("app.mapae.io", [])).toThrow("not a URL");
    });

    test("error messages name the caller's env var, not the bootstrap default", () => {
        // The revocation submitter reuses this parser for its public mode. An operator
        // who mistyped REVOCATION_ALLOWED_ORIGINS must not be told to fix a bootstrap
        // variable their service never reads.
        for (const bad of ["*", "not a url", "http://evil.example"]) {
            expect(() => parseBootstrapOrigins(bad, [], "REVOCATION_ALLOWED_ORIGINS")).toThrow(
                /REVOCATION_ALLOWED_ORIGINS/,
            );
        }
        expect(() => parseBootstrapOrigins("*", [])).toThrow(/BOOTSTRAP_ALLOWED_ORIGINS/);
    });
});

describe("costOfReceipt", () => {
    test("charges execution gas plus the OP-Stack L1 fee, which arrives as a hex string", () => {
        // The literal shape GIWA sends: viem BigInt-converts only the fields it knows,
        // so `l1Fee` survives as a string. This is the exact bug class that once turned
        // the daily cap into a no-op.
        const receipt = {gasUsed: 100n, effectiveGasPrice: 3n, l1Fee: "0x10"};
        expect(costOfReceipt(receipt, 999n)).toBe(100n * 3n + 16n);
    });

    test("an absent l1Fee is zero — anvil is not an OP-Stack chain", () => {
        expect(costOfReceipt({gasUsed: 100n, effectiveGasPrice: 3n}, 999n)).toBe(300n);
    });

    test("an unreadable l1Fee charges the fallback, never zero", () => {
        // The transaction mined; the one certainly-wrong answer is "free".
        const receipt = {gasUsed: 100n, effectiveGasPrice: 3n, l1Fee: {weird: true}};
        expect(costOfReceipt(receipt, 999n)).toBe(999n);
    });
});

describe("FixedWindowLimiter", () => {
    test("permits up to the limit inside one window, then refuses", () => {
        const limiter = new FixedWindowLimiter(3, 1_000);
        expect(limiter.tryConsume("a", 0)).toBe(true);
        expect(limiter.tryConsume("a", 100)).toBe(true);
        expect(limiter.tryConsume("a", 200)).toBe(true);
        expect(limiter.tryConsume("a", 300)).toBe(false);
    });

    test("keys are independent", () => {
        const limiter = new FixedWindowLimiter(1, 1_000);
        expect(limiter.tryConsume("a", 0)).toBe(true);
        expect(limiter.tryConsume("b", 0)).toBe(true);
        expect(limiter.tryConsume("a", 0)).toBe(false);
    });

    test("the window rolls", () => {
        const limiter = new FixedWindowLimiter(1, 1_000);
        expect(limiter.tryConsume("a", 0)).toBe(true);
        expect(limiter.tryConsume("a", 999)).toBe(false);
        expect(limiter.tryConsume("a", 1_000)).toBe(true);
    });

    test("sweep drops expired windows so distinct keys cannot grow the map forever", () => {
        const limiter = new FixedWindowLimiter(1, 1_000);
        for (let i = 0; i < 50; i += 1) limiter.tryConsume(`k${i}`, 0);
        expect(limiter.size).toBe(50);
        limiter.sweep(2_000);
        expect(limiter.size).toBe(0);
    });

    test("refuses a nonsensical configuration rather than running unbounded", () => {
        expect(() => new FixedWindowLimiter(0, 1_000)).toThrow("limit");
        expect(() => new FixedWindowLimiter(1, 0)).toThrow("windowMs");
    });
});

describe("SpendBudget", () => {
    test("reserves up to the daily limit and then refuses", () => {
        const budget = new SpendBudget(100n, 0);
        expect(budget.reserve(60n, 0)).toBe(true);
        expect(budget.reserve(60n, 0)).toBe(false);
        expect(budget.remaining(0)).toBe(40n);
    });

    test("settling less than reserved returns the difference to the budget", () => {
        const budget = new SpendBudget(100n, 0);
        expect(budget.reserve(60n, 0)).toBe(true);
        budget.settle(60n, 10n, 0);
        expect(budget.spentToday(0)).toBe(10n);
        expect(budget.remaining(0)).toBe(90n);
    });

    test("a reverted broadcast still charges — otherwise griefing is free", () => {
        const budget = new SpendBudget(100n, 0);
        budget.reserve(60n, 0);
        budget.settle(60n, 55n, 0);
        expect(budget.spentToday(0)).toBe(55n);
    });

    test("an in-flight reservation blocks a concurrent request before it lands", () => {
        const budget = new SpendBudget(100n, 0);
        expect(budget.reserve(80n, 0)).toBe(true);
        // Nothing settled yet — the second request must still see the budget consumed.
        expect(budget.reserve(80n, 0)).toBe(false);
    });

    test("the window rolls after a day", () => {
        const budget = new SpendBudget(100n, 0);
        budget.reserve(100n, 0);
        budget.settle(100n, 100n, 0);
        expect(budget.remaining(0)).toBe(0n);
        expect(budget.remaining(86_400_000)).toBe(100n);
    });

    test("refuses a non-positive limit", () => {
        expect(() => new SpendBudget(0n, 0)).toThrow("dailyLimitWei");
    });

    /**
     * This is the shape the l1Fee bug took, and the reason the guard is here rather than
     * only at the parse site. `bigint + string` concatenates instead of adding, so one
     * settle turned the running total into a string, and from then on
     * `string + bigint > bigint` compared as StringToBigInt(garbage) — always false — so
     * `reserve` accepted everything and `remaining` threw. A budget that silently stops
     * being a budget is worse than one that crashes.
     */
    test("refuses a non-bigint charge instead of poisoning the running total", () => {
        const budget = new SpendBudget(100n, 0);
        budget.reserve(60n, 0);
        expect(() => budget.settle(60n, "0x1f" as unknown as bigint, 0)).toThrow("bigint");
        // Fails closed on the money: an unreadable charge is billed at the reservation,
        // never at zero. The hold is still released, so the window is not stranded.
        expect(budget.spentToday(0)).toBe(60n);
        expect(budget.remaining(0)).toBe(40n);
        expect(budget.remaining(86_400_000)).toBe(100n);
    });
});

describe("readReceiptFeeField", () => {
    test("reads the hex string GIWA actually sends", () => {
        // Measured on the live RPC: eth_getTransactionReceipt for the D5 settlement
        // returns l1Fee: '0xe0e42b2c9'. giwaSepolia is a plain defineChain, so viem's
        // default formatter spreads it through as a string rather than a bigint.
        expect(readReceiptFeeField("0xe0e42b2c9")).toBe(0xe0e42b2c9n);
    });

    test("passes a bigint through, for a chain whose formatter already converted it", () => {
        expect(readReceiptFeeField(12_345n)).toBe(12_345n);
    });

    test("treats an absent field as zero — not every chain charges an L1 fee", () => {
        expect(readReceiptFeeField(undefined)).toBe(0n);
        expect(readReceiptFeeField(null)).toBe(0n);
    });

    test("reads a decimal string and an integer number", () => {
        expect(readReceiptFeeField("12345")).toBe(12_345n);
        expect(readReceiptFeeField(12_345)).toBe(12_345n);
    });

    test("refuses anything it cannot read rather than silently charging zero", () => {
        // Charging zero for a transaction that mined is exactly how the daily cap stops
        // binding, so an unreadable value has to be loud.
        expect(() => readReceiptFeeField("not a number")).toThrow("l1Fee");
        expect(() => readReceiptFeeField({})).toThrow("l1Fee");
        expect(() => readReceiptFeeField(1.5)).toThrow("l1Fee");
        expect(() => readReceiptFeeField(-1n)).toThrow("l1Fee");
    });
});

/** `SimpleFactory.deploy(bytes _bytecode, bytes32 _salt)` — selector + two args. */
function decodeSimpleFactoryDeploy(data: Hex): [Hex, Hex] {
    const selector = keccak256(toHex("deploy(bytes,bytes32)")).slice(0, 10);
    expect(data.slice(0, 10)).toBe(selector);
    const [bytecode, salt] = decodeArgs(`0x${data.slice(10)}` as Hex);
    return [bytecode, salt];
}

function decodeArgs(payload: Hex): [Hex, Hex] {
    // Minimal head/tail decode: (bytes, bytes32) → offset word, salt word, then length+data.
    const word = (index: number): Hex =>
        `0x${payload.slice(2 + index * 64, 2 + (index + 1) * 64)}` as Hex;
    const offset = Number(BigInt(word(0)));
    const salt = word(1);
    const lengthAt = 2 + offset * 2;
    const length = Number(BigInt(`0x${payload.slice(lengthAt, lengthAt + 64)}`));
    const start = lengthAt + 64;
    return [`0x${payload.slice(start, start + length * 2)}` as Hex, salt];
}

function create2Address(deployer: Address, salt: Hex, bytecode: Hex): Address {
    return getAddress(
        `0x${keccak256(
            encodePacked(
                ["bytes1", "address", "bytes32", "bytes32"],
                ["0xff", deployer, salt, keccak256(bytecode)],
            ),
        ).slice(-40)}`,
    );
}

// Keep the unused-import checker honest about the ABI helper we intentionally do not use.
void encodeAbiParameters;
void parseAbiParameters;
