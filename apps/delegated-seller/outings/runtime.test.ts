import {describe, expect, test} from 'bun:test';
import {buildErc7710PaymentRequirements, encodePaymentRequiredHeader, GIWA_SEPOLIA_CAIP2, MOCK_USDC} from '@mapae/shared';
import {ARCADE_PAY_TO, ARCADE_REDEEMER, ARCADE_SELLER} from '@mapae/arcade/tickets';
import {TRANSFER_EVENT_TOPIC} from '@mapae/delegation';
import {createOutingPayment, readOutingConfig} from './runtime';
import {deployment} from './validation';
import type {Job, Pending} from './store';
import type {Hex, Log} from 'viem';

const tx=`0x${'ab'.repeat(32)}` as Hex;
const payer='0x1234567890123456789012345678901234567890' as const;
const config=readOutingConfig({ARCADE_OUTINGS_ENABLED:'true',ARCADE_RECEIPT_TOKEN:'test-only-outing-bridge-token-123456789',ARCADE_AGENT_PRIVATE_KEY:`0x${'22'.repeat(32)}`})!;
const job={payer, context:'0x', agent:config.account.address} as Job;
const pending:Pending={game:'stamp',seed:1,header:'same-recorded-header',transaction:null};
const resource={ticket:{shop:{slug:'mapae-arcade'},item:{key:'stamp'},code:'ticket-123',transaction:tx},receipt:{transaction:tx,payer,method:'erc7710',network:GIWA_SEPOLIA_CAIP2,amount:'1',asset:MOCK_USDC.address,payTo:ARCADE_PAY_TO}};
const logs=[{address:MOCK_USDC.address,topics:[TRANSFER_EVENT_TOPIC,`0x${payer.slice(2).padStart(64,'0')}`,`0x${ARCADE_PAY_TO.slice(2).toLowerCase().padStart(64,'0')}`],data:`0x${(1000000n).toString(16).padStart(64,'0')}`} ] as Log[];
function offer(amount='1000000',payTo=ARCADE_PAY_TO) {
    const accepts=buildErc7710PaymentRequirements({amount,payTo,facilitatorAddresses:[ARCADE_REDEEMER],delegationManager:deployment.environment.DelegationManager});
    const body={x402Version:2 as const,resource:{url:`${ARCADE_SELLER}/stamp`},accepts:[accepts]};
    return Response.json(body,{status:402,headers:{'Payment-Required':encodePaymentRequiredHeader(body)}});
}
describe('fixed seller runtime receipt verification',()=>{
    test('replay never signs, targets only the selected fixed ticket and checks the chain Transfer',async()=>{
        let calls=0;
        const payment=createOutingPayment(config,request=>{
            calls++;expect(request.url).toBe(`${ARCADE_SELLER}/stamp`);expect(request.headers.get('Payment-Signature')).toBe(pending.header);
            return Response.json(resource);
        },{getTransactionReceipt:async({hash})=>{expect(hash).toBe(tx);return {status:'success',logs};}});
        expect(await payment.pay(job,pending,()=>{throw new Error('must not sign or replace header');})).toBe(tx);expect(calls).toBe(1);
    });
    test('missing, duplicate, wrong amount or reverted Transfer stays unresolved',async()=>{
        for(const receipt of [{status:'reverted' as const,logs},{status:'success' as const,logs:[]},{status:'success' as const,logs:[...logs,...logs]},
            {status:'success' as const,logs:[{...logs[0]!,data:`0x${(2000000n).toString(16).padStart(64,'0')}` as Hex}]}]){
            const payment=createOutingPayment(config,()=>Response.json(resource),{getTransactionReceipt:async()=>receipt});
            await expect(payment.pay(job,pending,()=>{})).rejects.toThrow('receipt_unconfirmed');
        }
    });
    test('non-200 replay never treats server prose as evidence of payment',async()=>{
        const payment=createOutingPayment(config,()=>Response.json(resource,{status:504}),{getTransactionReceipt:async()=>{throw new Error('must not reach');}});
        await expect(payment.pay(job,pending,()=>{})).rejects.toThrow('payment_unresolved');
    });
    test('changed ticket price or recipient refused before signing/dispatch',async()=>{
        for(const response of [offer('2000000'),offer('1000000',payer)]){
            let calls=0,persisted=false;
            const payment=createOutingPayment(config,()=>{calls++;return response;},{getTransactionReceipt:async()=>{throw new Error('must not reach');}});
            await expect(payment.pay(job,{...pending,header:null},()=>{persisted=true;})).rejects.toThrow();
            expect(calls).toBe(1);expect(persisted).toBe(false);
        }
    });
});
