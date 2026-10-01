import {ARCADE_TICKET_AMOUNT, ARCADE_TICKET_PRICE, ARCADE_TICKET_COST} from "@mapae/arcade/tickets";
import {createPublicClient, createWalletClient, getAddress, http, publicActions, TransactionReceiptNotFoundError} from "viem";
import type {Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {DelegationManager} from "@metamask/smart-accounts-kit/contracts";
import {buildDelegatedTransfer, loadDelegatedAgentRuntime, readReceiptFeeField, reconcileSettlementReceipt, validateDelegatedPayment, type ValidatedDelegatedPayment} from "@mapae/delegation";
import {buildErc7710SupportedPayload, giwaSepolia, MOCK_USDC} from "@mapae/shared";
import type {MapaeStore} from "@mapae/store";
import {SettlementRecovery} from "../facilitator-erc7710/recovery.js";
import {createPaymentRoutes} from "../facilitator-erc7710/routes.js";
import {beforeBroadcast, RedemptionRejected} from "../facilitator-erc7710/guards.js";
import {receiptFailure, settlementResponse, verifyKnownSettlement} from "../facilitator-erc7710/settlement.js";
import {limitedJson, localURL, object} from "./model.js";
import type {PaymentOptions} from "./payments.js";

/** Anvil-only RPC challenge, repeated before any serialized transaction is sent. */
export async function assertAnvil(rpc: string, transport: typeof fetch = fetch): Promise<void> {
    localURL(rpc);
    const response = await transport(rpc, {method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: {"content-type": "application/json"},
        body: JSON.stringify([{jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: []}, {jsonrpc: "2.0", id: 2, method: "anvil_nodeInfo", params: []}])});
    const body = await limitedJson(response, 16_384);
    if (!response.ok || !Array.isArray(body)) throw new Error("Anvil local fork required");
    const version = body.find((row: unknown) => object(row) && row.id === 1);
    const info = body.find((row: unknown) => object(row) && row.id === 2);
    if (!object(version) || typeof version.result !== "string" || !/anvil/i.test(version.result) || !object(info) || !object(info.result)) {
        throw new Error("Anvil local fork required");
    }
}

/** In-process facilitator shares the one checked Anvil transport. No external facilitator can forward a payment onto GIWA. */
export async function createFork(store: MapaeStore, env: Record<string, string | undefined>): Promise<PaymentOptions> {
    const rpc = localURL(env.GIWA_SEPOLIA_RPC_URL ?? "").href;
    await assertAnvil(rpc);
    const account = privateKeyToAccount(generatePrivateKey());
    const transport = http(rpc, {fetchOptions: {redirect: "error"}, timeout: 10_000, retryCount: 0});
    const publicClient = createPublicClient({chain: giwaSepolia, transport});
    const wallet = createWalletClient({chain: giwaSepolia, account, transport}).extend(publicActions);
    const supported = buildErc7710SupportedPayload({facilitatorAddresses: [account.address]});
    const runtime = await loadDelegatedAgentRuntime({env: {...env, SELLER_URL: "http://127.0.0.1:3004", FACILITATOR_URL: "http://127.0.0.1:3999",
        AGENT_MAX_PAYMENT_MUSDC: ARCADE_TICKET_PRICE, AGENT_SESSION_BUDGET_MUSDC: env.AGENT_SESSION_BUDGET_MUSDC ?? String(10 * ARCADE_TICKET_COST), AGENT_ALLOWED_PAY_TO: env.ARCADE_PAY_TO},
        fetchImpl: (async () => Response.json(supported)) as unknown as typeof fetch});
    const manager = runtime.delegationManager;
    // Only a disposable generated relayer is funded, and only through Anvil's private development RPC.
    await publicClient.request({method: "anvil_setBalance", params: [account.address, "0x2386f26fc10000"]} as never);
    const recovery = new SettlementRecovery(store.settlements, account.address, giwaSepolia.id, {total: 5_000_000_000_000_000n, payer: 5_000_000_000_000_000n});
    const transfer = (p: ValidatedDelegatedPayment) => {
        const t = buildDelegatedTransfer(p);
        return {delegations: [...t.delegations], modes: [...t.modes], executions: t.executions.map((b) => [...b])};
    };
    async function simulate(payment: ValidatedDelegatedPayment) {
        await assertAnvil(rpc);
        const result = await DelegationManager.simulate.redeemDelegations({client: wallet, delegationManagerAddress: manager, ...transfer(payment)});
        const gas = await wallet.estimateContractGas(result.request);
        if (gas > 1_000_000n) throw new RedemptionRejected("local fork gas ceiling exceeded");
        return gas;
    }
    function sign(payment: ValidatedDelegatedPayment, envelope: {nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint}) {
        return wallet.signTransaction({to: manager, data: DelegationManager.encode.redeemDelegations(transfer(payment)), type: "eip1559", chainId: giwaSepolia.id, ...envelope});
    }
    const facilitator = createPaymentRoutes({
        validate: (body) => validateDelegatedPayment(body, {delegationManager: manager, facilitator: account.address, maxAmount: ARCADE_TICKET_AMOUNT}),
        simulate: async (payment) => {
            const known = recovery.known(payment.paymentIntentId);
            if (known) return verifyKnownSettlement(known);
            await beforeBroadcast(() => simulate(payment));
        },
        settle: async (payment) => {
            const {record, replayed} = await recovery.settle({paymentIntentId: payment.paymentIntentId, payer: payment.payer,
                payTo: payment.paymentRequirements.payTo, amountBase: payment.amount}, {
                pendingNonce: () => beforeBroadcast(() => publicClient.getTransactionCount({address: account.address, blockTag: "pending"})),
                prepare: async (nonce) => {
                    const gas = await beforeBroadcast(() => simulate(payment));
                    const fees = await beforeBroadcast(() => publicClient.estimateFeesPerGas());
                    if (fees.maxFeePerGas > 10_000_000_000n) throw new RedemptionRejected("local fork fee ceiling exceeded");
                    return sign(payment, {nonce, gas, ...fees});
                },
                restore: (envelope) => sign(payment, envelope),
                receipt: async (hash) => {try {return await publicClient.getTransactionReceipt({hash});} catch (error) {if (error instanceof TransactionReceiptNotFoundError) return null; throw error;}},
                send: async (serializedTransaction: Hex) => {await assertAnvil(rpc); return wallet.sendRawTransaction({serializedTransaction});},
                wait: (hash) => publicClient.waitForTransactionReceipt({hash, timeout: 20_000}),
                failure: (receipt) => receiptFailure(receipt, payment),
            });
            return settlementResponse(record, replayed);
        },
    });
    facilitator.get("/supported", (c) => c.json(buildErc7710SupportedPayload({facilitatorAddresses: [account.address], delegationManager: manager})));
    return {mode: "fork", payTo: getAddress(env.ARCADE_PAY_TO!), facilitator: "http://127.0.0.1:3999",
        facilitatorFetch: (url, init) => Promise.resolve(facilitator.request(new URL(url).pathname, init)),
        client: {provider: runtime.provider, preflight: runtime.preflight, delegationManager: manager, trustedFacilitators: [account.address]},
        reconcile: async (intent) => {
            const record = store.settlements.get(intent);
            if (!record || record.terminal) return;
            await assertAnvil(rpc);
            let receipt;
            try {receipt = await publicClient.getTransactionReceipt({hash: record.txHash});}
            catch (error) {if (error instanceof TransactionReceiptNotFoundError) return; throw error;}
            if (receipt.transactionHash.toLowerCase() !== record.txHash.toLowerCase() || receipt.gasUsed <= 0n) throw new Error("original transaction receipt mismatch");
            const discrepancies = reconcileSettlementReceipt({logs: receipt.logs, asset: MOCK_USDC.address, payer: getAddress(record.payer), payTo: getAddress(record.payTo), amount: record.amountBase});
            store.settlements.finish(intent, {at: Date.now(), gasUsed: receipt.gasUsed,
                actualCost: receipt.gasUsed * receipt.effectiveGasPrice + readReceiptFeeField((receipt as {l1Fee?: unknown}).l1Fee),
                errorCode: receipt.status !== "success" ? "settlement_reverted" : discrepancies.length ? "vendor_not_credited" : undefined});
        },
    };
}
