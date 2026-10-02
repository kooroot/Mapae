import {describe,expect,test} from 'bun:test';
import {getAddress} from 'viem';
import {addCharacter,newArcadeState,newCompanion} from '../state';
import {arcadeStorageKey,serializeArcadeState} from '../state-store';
import {projectProfile} from './model';
import {readDeviceDraft,writeDeviceDraft,preserveDeviceDraft} from './device-store';
const owner='0x5ea109edc7e89b6a752032aa2b6f1092e081e7ec';
const state=()=>addCharacter(newArcadeState(),newCompanion('mobile',{name:'모바일친구',color:'jade',temperament:'calm'}));
function storage(fn:(values:Map<string,string>)=>void){
 const original=Object.getOwnPropertyDescriptors(globalThis), values=new Map<string,string>();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});
 Object.defineProperty(globalThis,'matchMedia',{configurable:true,value:()=>({matches:false})});
 try{fn(values);}finally{for(const key of ['localStorage','matchMedia']){if(original[key])Object.defineProperty(globalThis,key,original[key]!);else Reflect.deleteProperty(globalThis,key);}}
}
describe('reviewed wallet recovery store',()=>{
 test('retains existing device records until authenticated server acknowledgement',()=>storage(values=>{
  values.set(arcadeStorageKey(owner),serializeArcadeState(state()));
  const draft=readDeviceDraft(owner);expect(draft.imported).toBe(false);expect(draft.state.characters[0]?.name).toBe('모바일친구');
  writeDeviceDraft(owner,draft);expect(values.has(arcadeStorageKey(owner))).toBe(true);
  writeDeviceDraft(owner,{...draft,base:{owner,revision:1,profile:projectProfile(draft.state)},pending:false,imported:true});
  expect(values.has(arcadeStorageKey(owner))).toBe(false);expect(readDeviceDraft(owner).state).toEqual(state());
 }));
 test('a draft, its server base and conflict backup strip all credential extensions',()=>storage(values=>{
  const secret='test-secret-never-store', s={...state(),privateKey:secret};
  const draft={state:s,base:{owner,revision:1,profile:{...projectProfile(s),privateKey:secret},privateKey:secret},pending:true,imported:false,privateKey:secret};
  writeDeviceDraft(owner,draft);preserveDeviceDraft(owner,s);
  expect([...values.values()].join()).not.toContain(secret);expect([...values.values()].join()).not.toContain('privateKey');
 }));
 test('checksummed wallets share drafts while another owner starts empty',()=>storage(()=>{
  writeDeviceDraft(getAddress(owner),{state:state(),base:{owner:getAddress(owner),revision:2,profile:projectProfile(state())},pending:false,imported:true});
  expect(readDeviceDraft(owner).base?.revision).toBe(2);expect(readDeviceDraft('0x1111111111111111111111111111111111111111').state.characters).toHaveLength(0);
 }));
 test('failed local persistence never removes the original mobile record',()=>storage(values=>{
  values.set(arcadeStorageKey(owner),serializeArcadeState(state()));
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{setItem(){throw new Error('quota');},removeItem(){throw new Error('must not remove');}}});
  expect(writeDeviceDraft(owner,{state:state(),base:null,pending:true,imported:true})).toBe(false);expect(values.has(arcadeStorageKey(owner))).toBe(true);
 }));
});
