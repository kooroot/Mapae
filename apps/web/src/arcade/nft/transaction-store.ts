import {isAddress,isHash,type Address,type Hex} from 'viem';
import {guardianTokenId} from '@mapae/arcade/guardians';
export type NftTransaction={owner:Address;collection:Address;hash:Hex;kind:'mint'|'claim'|'recovery';tokenId?:string;nonce?:number};
const txKey=(owner:Address)=>{if(!isAddress(owner))throw Error('transaction_owner');return `mapae.guardian-transaction.${owner.toLowerCase()}`;};
/** Only public transaction identity is retained. Credentials and signed payloads are excluded. */
function project(value:unknown,owner:Address):NftTransaction {
    if(!value||typeof value!=='object')throw Error('transaction_record');
    const v=value as Record<string,unknown>;
    if(typeof v.owner!=='string'||v.owner.toLowerCase()!==owner.toLowerCase()||!isAddress(v.owner)||typeof v.collection!=='string'||!isAddress(v.collection)||typeof v.hash!=='string'||!isHash(v.hash)||(v.kind!=='mint'&&v.kind!=='claim'&&v.kind!=='recovery')||(v.tokenId!==undefined&&!guardianTokenId(v.tokenId)))throw Error('transaction_record');
    if(v.nonce!==undefined&&(typeof v.nonce!=='number'||!Number.isSafeInteger(v.nonce)||v.nonce<0))throw Error('transaction_record');
    return {owner:v.owner,collection:v.collection,hash:v.hash,kind:v.kind,...(v.tokenId===undefined?{}:{tokenId:v.tokenId as string}),...(v.nonce===undefined?{}:{nonce:v.nonce as number})};
}
export function readNftTransaction(owner:Address):NftTransaction|null {
    const raw=localStorage.getItem(txKey(owner));return raw?project(JSON.parse(raw),owner):null;
}
export function saveNftTransaction(tx:NftTransaction){localStorage.setItem(txKey(tx.owner),JSON.stringify(project(tx,tx.owner)));}
export function clearNftTransaction(owner:Address){localStorage.removeItem(txKey(owner));}
/** Refuse a new wallet request when recovery storage is corrupt, occupied or unwritable. */
export function assertNftTransactionStorage(owner:Address){
    if(readNftTransaction(owner))throw Error('transaction_pending');
    const probe=`${txKey(owner)}.check`;
    localStorage.setItem(probe,'1');
    if(localStorage.getItem(probe)!=='1')throw Error('transaction_storage');
    localStorage.removeItem(probe);
}
