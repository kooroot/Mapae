import {privateKeyToAccount} from 'viem/accounts';
import {createPublicClient, getAddress, isAddress, isHash, type Hex, type TransactionReceipt} from 'viem';
import {assertFundedKeySeparation} from '@mapae/delegation/account-bootstrap';
import {createMapaeDelegationProvider} from '@mapae/delegation/x402';
import {payForDelegatedResource} from '@mapae/delegation/payment-client';
import {reconcileSettlementReceipt, throttledHttp} from '@mapae/delegation';
import {ARCADE_PAY_TO, ARCADE_REDEEMER, ARCADE_SELLER, ARCADE_TICKET_AMOUNT} from '@mapae/arcade/tickets';
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC, giwaSepolia, parseNodeRpcUrl, toTokenAmount} from '@mapae/shared';
import {deployment, object} from './validation';
import type {OutingPayment} from './runner';
import type {Job, Pending} from './store';

export function readOutingConfig(env: Record<string, string | undefined> = process.env) {
    if (env.ARCADE_OUTINGS_ENABLED !== undefined && !['true','false'].includes(env.ARCADE_OUTINGS_ENABLED)) throw new Error('ARCADE_OUTINGS_ENABLED must be true or false');
    if (env.ARCADE_OUTINGS_ENABLED !== 'true') return null;
    if (!env.ARCADE_RECEIPT_TOKEN || env.ARCADE_RECEIPT_TOKEN.trim().length < 32) throw new Error('ARCADE_RECEIPT_TOKEN required for outings');
    const key = env.ARCADE_AGENT_PRIVATE_KEY?.trim();
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('ARCADE_AGENT_PRIVATE_KEY must be a dedicated session key');
    let account: ReturnType<typeof privateKeyToAccount>;
    try {account = privateKeyToAccount(key as Hex);} catch {throw new Error('ARCADE_AGENT_PRIVATE_KEY is invalid');}
    const roles: Record<string, `0x${string}`> = {ARCADE_AGENT: account.address};
    for (const name of ['ARCADE_RESULT_PRIVATE_KEY','PRIVATE_KEY','DEPLOYER_PRIVATE_KEY','GUARDIAN_DEPLOYER_PRIVATE_KEY','FRAMEWORK_ADMIN_PRIVATE_KEY','GUARDIAN_ADMIN_PRIVATE_KEY','FACILITATOR_SIGNER_PRIVATE_KEY','BOOTSTRAP_PRIVATE_KEY','REVOCATION_RELAYER_PRIVATE_KEY','REVOCATION_SPONSOR_PRIVATE_KEY']) {
        const value = env[name]?.trim();
        if (value) {try {roles[name] = privateKeyToAccount(value as Hex).address;} catch {throw new Error(`${name} invalid`);}}
    }
    for (const name of ['DEPLOYER_ADDRESS','GUARDIAN_DEPLOYER_ADDRESS','FRAMEWORK_ADMIN_ADDRESS','GUARDIAN_ADMIN_ADDRESS','FACILITATOR_SIGNER_ADDRESS','BOOTSTRAP_ADDRESS','REVOCATION_RELAYER_ADDRESS','REVOCATION_SPONSOR_ADDRESS']) {
        const value = env[name]?.trim();
        if (value) {
            if (!isAddress(value)) throw new Error(`${name} must be an address`);
            if (getAddress(value) === account.address) throw new Error('ARCADE_AGENT_PRIVATE_KEY must not be a funded service key');
        }
    }
    // Compare only the new role to siblings: existing same-role key/address aliases are legal.
    for (const [name, address] of Object.entries(roles)) {if (name !== 'ARCADE_AGENT') assertFundedKeySeparation({ARCADE_AGENT: account.address, [name]: address});}
    if (account.address === ARCADE_REDEEMER || account.address === ARCADE_PAY_TO) throw new Error('ARCADE_AGENT_PRIVATE_KEY must be separate from settlement roles');
    const rpcUrl = parseNodeRpcUrl(env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0]);
    return {account, token: env.ARCADE_RECEIPT_TOKEN.trim(), rpcUrl};
}

export function receiptTransaction(value: unknown, job: Job, pending: Pending): Hex {
    if (!object(value) || !object(value.ticket) || !object(value.receipt)) throw new Error('invalid_receipt');
    const t = value.ticket, r = value.receipt;
    if (!object(t.shop) || t.shop.slug !== 'mapae-arcade' || !object(t.item) || t.item.key !== pending.game ||
        typeof t.code !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(t.code) || typeof t.transaction !== 'string' || !isHash(t.transaction) || r.transaction !== t.transaction ||
        typeof r.payer !== 'string' || !isAddress(r.payer) || getAddress(r.payer) !== job.payer || r.method !== 'erc7710' || r.network !== GIWA_SEPOLIA_CAIP2 ||
        typeof r.amount !== 'string' || toTokenAmount(r.amount) !== ARCADE_TICKET_AMOUNT || typeof r.asset !== 'string' || !isAddress(r.asset) || getAddress(r.asset) !== MOCK_USDC.address ||
        typeof r.payTo !== 'string' || !isAddress(r.payTo) || getAddress(r.payTo) !== ARCADE_PAY_TO) throw new Error('invalid_receipt');
    return t.transaction;
}

export function createOutingPayment(config: NonNullable<ReturnType<typeof readOutingConfig>>, localFetch: (request: Request) => Promise<Response> | Response,
    client: {getTransactionReceipt: (request: {hash: Hex}) => Promise<Pick<TransactionReceipt, 'status' | 'logs'>>} = createPublicClient({chain: giwaSepolia, transport: throttledHttp(config.rpcUrl, {}, {timeout: 15_000, retryCount: 1})})): OutingPayment {
    return {async pay(job, pending, persist) {
        const target = `${ARCADE_SELLER}/${pending.game}`;
        const submit = (header: string) => localFetch(new Request(target, {headers: {'Payment-Signature': header, Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(60_000)}));
        let resource: unknown;
        if (pending.header) {
            const response = await submit(pending.header);
            if (!response.ok) throw new Error('payment_unresolved');
            resource = await response.json();
        } else {
            const provider = createMapaeDelegationProvider({account: config.account, environment: deployment.environment,
                parentPermissionContext: job.context, facilitatorAddresses: [ARCADE_REDEEMER]});
            const result = await payForDelegatedResource(new URL(target), {provider, delegationManager: getAddress(deployment.environment.DelegationManager), trustedFacilitators: [ARCADE_REDEEMER],
                preflight: async offer => offer.amount === ARCADE_TICKET_AMOUNT.toString() && getAddress(offer.payTo) === ARCADE_PAY_TO && offer.maxTimeoutSeconds <= 300
                    ? {ok: true} : {ok: false, code: 'SPEND_POLICY_REFUSED', detail: 'fixed arcade ticket required'},
                fetchImpl: Object.assign(async (url: RequestInfo | URL, options?: RequestInit) => {
                    if (String(url) !== target) throw new Error('destination_refused');
                    const header = new Headers(options?.headers).get('Payment-Signature');
                    if (header) {persist(header); return submit(header);}
                    return localFetch(new Request(target, {headers: {Accept: 'application/json'}}));
                }, {preconnect: fetch.preconnect}),
            });
            if (!result.ok) throw new Error('payment_unresolved');
            resource = result.resource;
        }
        const transaction = receiptTransaction(resource, job, pending);
        const receipt = await client.getTransactionReceipt({hash: transaction});
        if (receipt.status !== 'success' || reconcileSettlementReceipt({logs: receipt.logs, asset: MOCK_USDC.address, payer: job.payer,
            payTo: ARCADE_PAY_TO, amount: ARCADE_TICKET_AMOUNT}).length) throw new Error('receipt_unconfirmed');
        return transaction;
    }};
}
