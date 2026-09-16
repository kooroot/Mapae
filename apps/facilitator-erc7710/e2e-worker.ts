/** Disposable Anvil fixture: exercises production routes/recovery, not delegation authorization. */
import {createPublicClient, createWalletClient, http, TransactionReceiptNotFoundError, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {anvil} from "viem/chains";
import {openStore} from "@mapae/store";
import {SettlementRecovery} from "./recovery.js";
import {createPaymentRoutes} from "./routes.js";
import {settlementResponse} from "./settlement.js";
const rpc = process.env.RECOVERY_RPC!;
if (new URL(rpc).hostname !== "127.0.0.1") throw new Error("fixture requires loopback RPC");
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const client = createPublicClient({chain: anvil, transport: http(rpc, {retryCount: 0})});
const wallet = createWalletClient({account, chain: anvil, transport: http(rpc, {retryCount: 0})});
const store = openStore(process.env.RECOVERY_DB!);
const recovery = new SettlementRecovery(store.settlements, account.address, anvil.id,
    {total: 10n ** 18n, payer: 10n ** 18n}, () => Number(process.env.RECOVERY_NOW));
const app = createPaymentRoutes({
    validate(body: unknown) {
        const b = body as {id?: string; to?: string};
        if (!b || !/^0x[0-9a-f]{64}$/.test(b.id ?? "") || !/^0x[0-9a-f]{40}$/.test(b.to ?? "")) throw new Error("invalid fixture");
        return {paymentIntentId: b.id as Hex, payer: account.address, payTo: b.to as Hex, amountBase: 123n};
    },
    simulate: async () => {},
    async settle(payment) {
        const sign = (e: {nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint}) =>
            wallet.signTransaction({to: payment.payTo, value: payment.amountBase, type: "eip1559", ...e});
        return settlementResponse(await recovery.settle(payment, {
            pendingNonce: () => client.getTransactionCount({address: account.address, blockTag: "pending"}),
            prepare: (nonce) => sign({nonce, gas: 50000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n}),
            restore: sign,
            receipt: async (hash) => {try {return await client.getTransactionReceipt({hash});}
                catch (error) {if (error instanceof TransactionReceiptNotFoundError) return null; throw error;}},
            send: (serializedTransaction) => wallet.sendRawTransaction({serializedTransaction}),
            wait: (hash) => client.waitForTransactionReceipt({hash, timeout: 700, pollingInterval: 50}),
            failure: (receipt) => receipt.status === "reverted" ? "settlement_reverted" : undefined,
        }));
    },
});
const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: app.fetch});
console.log(`READY ${server.port}`);
