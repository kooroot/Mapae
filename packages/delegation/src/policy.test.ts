import {describe, expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {getAddress, hexToBigInt, size, slice, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    encodePaymentHeader,
    MOCK_USDC,
    toTokenAmount,
} from "@mapae/shared";
import {
    ENTRY_POINT_V07,
    MAX_PERMISSION_CONTEXT_HEX_LENGTH,
    parseActiveDeploymentArtifact,
    parseD3IdentityConfig,
    parseDeploymentArtifact,
} from "./config.js";
import {FRAMEWORK_COMPOSITION_ID} from "./composition.js";
import {
    buildD3Policies,
    preparePeriodDelegation,
    withDelegationSignature,
    type PeriodPolicy,
} from "./policy.js";
import {createMapaeDelegationProvider} from "./x402.js";

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
const FIXED_VENDOR = address(20);
const PAYER = address(0x99);
const FACILITATOR = address(0x30);
const D3_POLICIES = buildD3Policies(FIXED_VENDOR);

/**
 * GIWA Sepolia에 실제로 배포된 주소들.
 *
 * 총액 caveat이 우리가 배포한 그 enforcer를 가리키는지는 이 파일이 만든 가짜 주소로는
 * 증명되지 않는다 — 가짜 환경에서는 무엇을 넣어도 자기 자신과 일치한다. 길이 실측도
 * 같은 이유로 이 환경에서 한다.
 */
const FORGE_ADDRESSES = JSON.parse(
    readFileSync(
        new URL(
            "../../../deployments/giwa-sepolia.framework-forge-addresses.json",
            import.meta.url,
        ),
        "utf8",
    ),
) as Record<string, string>;

function forge(name: string): Address {
    const value = FORGE_ADDRESSES[name];
    if (!value) throw new Error(`${name} is missing from the forge address file`);
    return getAddress(value);
}

const deployedEnvironment: SmartAccountsEnvironment = {
    DelegationManager: forge("DelegationManager"),
    EntryPoint: ENTRY_POINT_V07,
    SimpleFactory: forge("SimpleFactory"),
    implementations: {HybridDeleGatorImpl: forge("HybridDeleGatorImpl")},
    caveatEnforcers: {
        ValueLteEnforcer: forge("ValueLteEnforcer"),
        ERC20PeriodTransferEnforcer: forge("ERC20PeriodTransferEnforcer"),
        ERC20TransferAmountEnforcer: forge("ERC20TransferAmountEnforcer"),
        AllowedCalldataEnforcer: forge("AllowedCalldataEnforcer"),
        TimestampEnforcer: forge("TimestampEnforcer"),
        RedeemerEnforcer: forge("RedeemerEnforcer"),
    },
};

/**
 * `packages/seller/src/index.ts`의 `MAX_PAYMENT_HEADER_LENGTH`.
 *
 * 그 상수는 판매자 미들웨어 안의 모듈 private이고 이 리프는 그 파일을 건드리지 않으므로
 * 값을 옮기지 못했다. 헤더 코덱 옆(`@mapae/shared`)으로 올려 양쪽이 한 상수를 읽게 하는
 * 제안은 보고에 있다.
 */
const SELLER_MAX_PAYMENT_HEADER_LENGTH = 150_000;

function termsFor(
    caveats: readonly {enforcer: string; terms: Hex}[],
    enforcer: Address,
): Hex | undefined {
    return caveats.find((caveat) => getAddress(caveat.enforcer) === enforcer)?.terms;
}

const environment: SmartAccountsEnvironment = {
    DelegationManager: address(1),
    EntryPoint: ENTRY_POINT_V07,
    SimpleFactory: address(2),
    implementations: {HybridDeleGatorImpl: address(3)},
    caveatEnforcers: {
        ValueLteEnforcer: address(4),
        ERC20PeriodTransferEnforcer: address(5),
        ERC20TransferAmountEnforcer: address(6),
        AllowedCalldataEnforcer: address(7),
        TimestampEnforcer: address(8),
        RedeemerEnforcer: address(9),
    },
};
const transactionHash = `0x${"ab".repeat(32)}`;
const pendingDeployment = {
    schemaVersion: 2,
    state: "ownership-pending",
    chainId: 91342,
    frameworkVersion: "1.3.0",
    compositionId: FRAMEWORK_COMPOSITION_ID,
    environment,
    admin: {
        deployer: address(30),
        owner: address(30),
        pendingOwner: address(31),
        ownershipTransferTransaction: transactionHash,
        verificationBlock: "123",
    },
};

describe("MetaMask Delegation Framework policy construction", () => {
    test("parses role addresses from application configuration and rejects zero", () => {
        expect(
            parseD3IdentityConfig({
                case1Owner: address(20),
                case2Vendor: address(22),
                frameworkAdmin: address(21),
            }),
        ).toEqual({
            case1Owner: address(20),
            case2Vendor: address(22),
            frameworkAdmin: address(21),
        });
        expect(() =>
            parseD3IdentityConfig({
                case1Owner: address(20),
                case2Vendor: address(22),
                frameworkAdmin: address(0),
            }),
        ).toThrow("frameworkAdmin must not be the zero address");
    });

    test("builds open and fixed-vendor parent delegations with on-chain caveats", () => {
        const open = preparePeriodDelegation({
            environment,
            delegator: address(10),
            delegate: address(11),
            policy: D3_POLICIES["open-agent"],
            startDate: 2_000_000_000,
        });
        const vendor = preparePeriodDelegation({
            environment,
            delegator: address(10),
            delegate: address(12),
            policy: D3_POLICIES["vendor-agent"],
            startDate: 2_000_000_000,
        });

        // ValueLte + 기간 상한은 scope가, 나머지는 정책이 붙인다: 유효 창 → 평생 총액 →
        // 수취인 고정.
        expect(open.caveats.map((item) => getAddress(item.enforcer))).toEqual([
            address(4),
            address(5),
            address(8),
            address(6),
        ]);
        expect(vendor.caveats.map((item) => getAddress(item.enforcer))).toEqual([
            address(4),
            address(5),
            address(8),
            address(6),
            address(7),
        ]);
        expect(vendor.delegate).toBe(address(12));
        expect(D3_POLICIES["vendor-agent"].recipient).toBe(FIXED_VENDOR);
    });

    test("총액을 준 정책은 배포된 enforcer에 토큰과 금액을 실어 보낸다", () => {
        const policy = D3_POLICIES["open-agent"];
        expect(policy.lifetimeTotalAmount).toBe(toTokenAmount("12"));
        // 기간 상한의 네 배. 30분 창에서 기간은 30번 갱신되므로 총액이 없으면 90 mUSDC다.
        expect(policy.lifetimeTotalAmount).toBe(policy.periodAmount * 4n);

        const delegation = preparePeriodDelegation({
            environment: deployedEnvironment,
            delegator: PAYER,
            delegate: address(11),
            policy,
            startDate: 2_000_000_000,
        });
        const terms = termsFor(delegation.caveats, forge("ERC20TransferAmountEnforcer"));
        if (!terms) throw new Error("lifetime total caveat is missing");
        // `ERC20TransferAmountEnforcer` terms는 ABI 인코딩이 아니라 packed다: 토큰 20바이트
        // 뒤에 금액 32바이트.
        expect(size(terms)).toBe(52);
        expect(getAddress(slice(terms, 0, 20))).toBe(getAddress(MOCK_USDC.address));
        expect(hexToBigInt(slice(terms, 20, 52))).toBe(toTokenAmount("12"));
        expect(getAddress(policy.token)).toBe(getAddress(MOCK_USDC.address));
    });

    test("총액이 없는 역할은 caveat이 늘지 않는다", () => {
        const child = D3_POLICIES["child-a"];
        // 자식은 manager 아래로 다시 위임되고 부모의 총액이 두 자식의 합을 이미 덮는다.
        expect(child.lifetimeTotalAmount).toBeUndefined();
        const delegation = preparePeriodDelegation({
            environment: deployedEnvironment,
            delegator: PAYER,
            delegate: address(11),
            policy: child,
            startDate: 2_000_000_000,
        });
        expect(delegation.caveats).toHaveLength(3);
        expect(
            termsFor(delegation.caveats, forge("ERC20TransferAmountEnforcer")),
        ).toBeUndefined();
    });

    test("총액은 양수여야 하고 기간 상한보다 작을 수 없다", () => {
        const base = D3_POLICIES["open-agent"];
        const prepare = (lifetimeTotalAmount: bigint) =>
            preparePeriodDelegation({
                environment: deployedEnvironment,
                delegator: PAYER,
                delegate: address(11),
                policy: {...base, lifetimeTotalAmount},
                startDate: 2_000_000_000,
            });
        expect(() => prepare(0n)).toThrow("lifetimeTotalAmount must be positive");
        expect(() => prepare(-1n)).toThrow("lifetimeTotalAmount must be positive");
        expect(() => prepare(base.periodAmount - 1n)).toThrow(
            "lifetimeTotalAmount must not be smaller than periodAmount",
        );
        // 같으면 받는다 — "한 기간치를 딱 한 번"은 스스로 성립하는 정책이다.
        expect(prepare(base.periodAmount).caveats).toHaveLength(4);
    });

    test("caveat 하나가 늘어도 부모 + 리프 체인은 상한 안에 들어온다", async () => {
        const session = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);

        // 가장 긴 부모를 잰다: 총액과 수취인 고정을 모두 든 vendor-agent(caveat 5개).
        const encodeRoot = (policy: PeriodPolicy) =>
            encodeDelegations([
                withDelegationSignature(
                    preparePeriodDelegation({
                        environment: deployedEnvironment,
                        delegator: PAYER,
                        delegate: session.address,
                        policy,
                        startDate: 2_000_000_000,
                    }),
                    `0x${"11".repeat(65)}` as Hex,
                ),
            ]);
        const vendorPolicy = D3_POLICIES["vendor-agent"];
        const parent = encodeRoot(vendorPolicy);
        const parentWithoutTotal = encodeRoot({
            ...vendorPolicy,
            lifetimeTotalAmount: undefined,
        });

        const requirements = buildErc7710PaymentRequirements({
            payTo: FIXED_VENDOR,
            amount: toTokenAmount("1"),
            facilitatorAddresses: [FACILITATOR],
        });
        const {permissionContext} = await createMapaeDelegationProvider({
            account: session,
            environment: deployedEnvironment,
            parentPermissionContext: parent,
            facilitatorAddresses: [FACILITATOR],
        })(requirements);
        const header = encodePaymentHeader(
            buildErc7710PaymentPayload({
                accepted: requirements,
                delegationManager: forge("DelegationManager"),
                permissionContext,
                delegator: PAYER,
            }),
        );

        console.log(
            `[measured] parent ${parent.length} hex (총액 없이 ${parentWithoutTotal.length}), ` +
                `parent+leaf ${permissionContext.length} hex, ` +
                `Payment-Signature ${header.length} chars`,
        );

        // caveat 하나의 값(실측): 인코딩된 위임이 576 hex = 288바이트 = 9워드 늘어난다.
        // `Caveat[]`의 head 워드와 구조체의 enforcer·offset·length 워드들, 그리고 64바이트로
        // 패딩된 52바이트 terms의 합이다. 이 숫자가 바뀌면 아래 여유 계산의 근거가 바뀐 것이다.
        expect(parent.length - parentWithoutTotal.length).toBe(576);
        expect(parent.length).toBeLessThan(MAX_PERMISSION_CONTEXT_HEX_LENGTH);
        expect(permissionContext.length).toBeLessThan(MAX_PERMISSION_CONTEXT_HEX_LENGTH);
        expect(header.length).toBeLessThan(SELLER_MAX_PAYMENT_HEADER_LENGTH);
        // 여유가 한 자리 수준이 아니라는 것까지 잰다. 실측은 부모+리프 6530 hex(상한의 20배
        // 아래), 헤더 9392자(상한의 16배 아래)이므로, caveat이 여기서 열 개 더 늘어도
        // 어느 상한에도 닿지 않는다.
        expect(permissionContext.length * 10).toBeLessThan(MAX_PERMISSION_CONTEXT_HEX_LENGTH);
        expect(header.length * 10).toBeLessThan(SELLER_MAX_PAYMENT_HEADER_LENGTH);
    });

    test("deployment artifact rejects a non-canonical EntryPoint", () => {
        expect(() =>
            parseDeploymentArtifact({
                ...pendingDeployment,
                environment: {...pendingDeployment.environment, EntryPoint: address(99)},
            }),
        ).toThrow("canonical v0.7");
    });

    test("keeps ownership-pending evidence separate from active deployments", () => {
        const pending = parseDeploymentArtifact(pendingDeployment);
        expect(pending.state).toBe("ownership-pending");
        expect(() => parseActiveDeploymentArtifact(pendingDeployment)).toThrow(
            "ownership is still pending",
        );

        const active = parseActiveDeploymentArtifact({
            ...pendingDeployment,
            state: "active",
            admin: {
                ...pendingDeployment.admin,
                owner: pendingDeployment.admin.pendingOwner,
                pendingOwner: null,
                ownershipAcceptanceTransaction: `0x${"cd".repeat(32)}`,
                verificationBlock: "130",
            },
        });
        expect(active.state).toBe("active");
        expect(active.admin.pendingOwner).toBeNull();
    });
});
