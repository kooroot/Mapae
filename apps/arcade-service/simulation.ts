import {ARCADE_TICKET_AMOUNT} from "@mapae/arcade/tickets";
import {getAddress, keccak256, toBytes} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {signDelegation, type SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {buildD3Policies, createMapaeDelegationProvider, ENTRY_POINT_V07, preparePeriodDelegation, validateDelegatedPayment, withDelegationSignature} from "@mapae/delegation";
import {buildErc7710SupportedPayload, GIWA_SEPOLIA_CAIP2, giwaSepolia} from "@mapae/shared";
import type {MapaeStore} from "@mapae/store";
import type {PaymentOptions} from "./payments.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const FACILITATOR = addr(30), PAY_TO = addr(20);
const environment: SmartAccountsEnvironment = {
    DelegationManager: addr(1), EntryPoint: ENTRY_POINT_V07, SimpleFactory: addr(2), implementations: {HybridDeleGatorImpl: addr(3)},
    caveatEnforcers: {ValueLteEnforcer: addr(4), ERC20PeriodTransferEnforcer: addr(5), ERC20TransferAmountEnforcer: addr(6),
        AllowedCalldataEnforcer: addr(7), TimestampEnforcer: addr(8), RedeemerEnforcer: addr(9)},
};
/** A network-free fixture, with real signed delegation encoding and the real durable settlement journal. No chain claim is made. */
export async function createSimulation(store: MapaeStore, behavior: "settle" | "unknown" | "reject" = "settle"): Promise<PaymentOptions> {
    const ownerKey = generatePrivateKey();
    const owner = privateKeyToAccount(ownerKey), session = privateKeyToAccount(generatePrivateKey());
    const root = preparePeriodDelegation({environment, delegator: owner.address, delegate: session.address,
        policy: buildD3Policies(PAY_TO)["open-agent"], startDate: Math.floor(Date.now() / 1000) - 1});
    const signature = await signDelegation({privateKey: ownerKey, delegation: root, delegationManager: environment.DelegationManager, chainId: giwaSepolia.id});
    const provider = createMapaeDelegationProvider({account: session, environment, parentPermissionContext: encodeDelegations([withDelegationSignature(root, signature)]), facilitatorAddresses: [FACILITATOR]});
    return {
        mode: "simulation", payTo: PAY_TO, facilitator: "http://127.0.0.1:3999",
        client: {provider, delegationManager: environment.DelegationManager, trustedFacilitators: [FACILITATOR]},
        facilitatorFetch: async (url, init) => {
            const path = new URL(url).pathname;
            if (path === "/supported") return Response.json(buildErc7710SupportedPayload({facilitatorAddresses: [FACILITATOR], delegationManager: environment.DelegationManager}));
            const request = JSON.parse(String(init?.body));
            const payment = validateDelegatedPayment(request, {delegationManager: environment.DelegationManager, facilitator: FACILITATOR, maxAmount: ARCADE_TICKET_AMOUNT});
            if (path === "/verify") return Response.json({isValid: behavior !== "reject", payer: payment.payer, ...(behavior === "reject" ? {invalidReason: "delegation_rejected"} : {})});
            if (path !== "/settle") throw new Error("unexpected fixture route");
            const txHash = keccak256(toBytes(`SIMULATION:${payment.paymentIntentId}`));
            const at = Date.now();
            const record = store.settlements.claim({paymentIntentId: payment.paymentIntentId, txHash, signer: FACILITATOR, chainId: giwaSepolia.id,
                nonce: store.settlements.nextNonce(FACILITATOR, giwaSepolia.id, 0), gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n,
                payer: payment.payer, payTo: PAY_TO, amountBase: payment.amount, createdAt: at}, {total: 1000n, payer: 1000n});
            if (behavior === "unknown") return Response.json({success: false, errorReason: "settlement_pending", transaction: record.txHash, network: GIWA_SEPOLIA_CAIP2, payer: payment.payer});
            store.settlements.finish(payment.paymentIntentId, {at, gasUsed: 1n, actualCost: 1n});
            return Response.json({success: true, network: GIWA_SEPOLIA_CAIP2, payer: payment.payer, transaction: record.txHash});
        },
    };
}
