import {useCallback,useEffect,useRef,useState} from 'react';
import {useAccount,useConfig,useSwitchChain} from 'wagmi';
import {getConnectorClient} from 'wagmi/actions';
import {writeContract} from 'viem/actions';
import {BaseError,bytesToHex,ContractFunctionRevertedError,ContractFunctionZeroDataError,isAddress,isHash,parseAbiItem,type Address,type Hex} from 'viem';
import {guardianAbi} from '@mapae/arcade/guardian-abi';
import {GUARDIAN_CHAIN_ID,GUARDIAN_ENTROPY,GUARDIAN_PROVIDER} from '@mapae/arcade/guardians';
import {publicClient} from '../../lib/config';
import {ProfileError,profileRequest} from '../profile/client';
import {giwaWalletError} from '../giwa-wallet';
import type {GuardianClaimBatch,GuardianDetail,GuardianRoster,GuardianToken} from '../profile/guardians';
import {refreshedDetail,sameAddress,verifiedClaims,verifyReplacement} from './model';
import {assertNftTransactionStorage,clearNftTransaction,readNftTransaction,saveNftTransaction,type NftTransaction} from './transaction-store';
import {entropyRecoveryAbi,verifyRevelation} from './recovery';
import {trackEngagement} from '../engagement/client';

/** One instance per page: its lock guards draws, claims and recoveries against double submission. */
export function useGuardians(owner:Address|undefined,ready:boolean,ko:boolean){
    const {address,connector}=useAccount(), config=useConfig(),{switchChainAsync}=useSwitchChain();
    const [roster,setRoster]=useState<GuardianRoster|null>(null),[detail,setDetail]=useState<GuardianDetail|null>(null),[selected,setSelected]=useState<string|null>(null);
    const [error,setError]=useState(''),[busy,setBusy]=useState(false),[phase,setPhase]=useState(''),[loading,setLoading]=useState(false),[paused,setPaused]=useState(true),[transaction,setTransaction]=useState<NftTransaction|null>(null);
    const rosterRef=useRef<GuardianRoster|null>(null),loadFailed=useRef(false),alive=useRef(true),locked=useRef(false),refreshing=useRef(false),selectedRef=useRef(selected),identity=useRef({address,uid:connector?.uid}),scope=useRef(owner);selectedRef.current=selected;identity.current={address,uid:connector?.uid};scope.current=owner;
    // A switched wallet starts from nothing: no roster, guardian or recovery record of the previous owner survives one render.
    const [shown,setShown]=useState(owner);
    if(shown!==owner){setShown(owner);setRoster(null);rosterRef.current=null;setDetail(null);setSelected(null);setError('');setTransaction(null);setPaused(true);}
    const live=(target:Address)=>alive.current&&scope.current===target;
    useEffect(()=>{alive.current=true;refreshing.current=false;if(!owner)return;try{setTransaction(readNftTransaction(owner));}catch{setError(ko?'트랜잭션 복구 기록을 읽지 못했어요.':'Transaction recovery record is unavailable.');}return()=>{alive.current=false;};},[owner]);
    const refresh=useCallback(async()=>{
        if(!owner||!ready||refreshing.current)return;refreshing.current=true;setLoading(true);
        try{
            const value=await profileRequest(owner,'/guardians') as GuardianRoster;
            if(!live(owner))return;
            if(value.chainId!==GUARDIAN_CHAIN_ID||!Array.isArray(value.guardians)||value.guardians.some(t=>!sameAddress(t.owner,owner))||value.enabled&&(!value.collection||!isAddress(value.collection)))throw Error('roster');
            setRoster(value);rosterRef.current=value;
            const id=value.guardians.find(t=>t.tokenId===selectedRef.current)?.tokenId??value.guardians[0]?.tokenId??null;
            if(selectedRef.current!==id)setDetail(null);
            setSelected(id);selectedRef.current=id;
            // The journal never waits on mint-only reads: the roster and detail load first, the mint state on its own.
            if(id){const d=await profileRequest(owner,`/guardians/${id}`) as GuardianDetail;if(live(owner)&&selectedRef.current===id)setDetail(previous=>refreshedDetail(previous,d));}else setDetail(null);
            // Only a load failure is cleared by a load success; a wallet error stays until the next action.
            if(live(owner)&&loadFailed.current){loadFailed.current=false;setError('');}
        }catch{if(live(owner)){loadFailed.current=true;setPaused(true);setError(ko?'전령 상태를 확인하지 못했어요. 잠시 뒤 다시 불러와 주세요.':'Could not verify your guardians. Try loading them again shortly.');}}finally{refreshing.current=false;if(alive.current)setLoading(false);}
        const collection=rosterRef.current?.enabled?rosterRef.current.collection:null;
        if(!collection){if(live(owner))setPaused(true);return;}
        try{const p=await publicClient.readContract({address:collection,abi:guardianAbi,functionName:'mintPaused'});if(live(owner))setPaused(p);}catch{if(live(owner))setPaused(true);}
    },[owner,ready,ko]);
    useEffect(()=>{void refresh();const poll=setInterval(()=>{if(!document.hidden&&!locked.current)void refresh();},12000);const focus=()=>{if(!document.hidden&&!locked.current)void refresh();};window.addEventListener('focus',focus);return()=>{clearInterval(poll);window.removeEventListener('focus',focus);};},[refresh]);
    async function select(id:string){if(!owner)return;setSelected(id);selectedRef.current=id;setDetail(null);try{const d=await profileRequest(owner,`/guardians/${id}`) as GuardianDetail;if(live(owner)&&selectedRef.current===id)setDetail(d);}catch{if(!live(owner))return;setError(ko?'이 전령을 불러올 수 없어요. 소유권을 다시 확인해 주세요.':'Guardian unavailable. Refresh ownership.');void refresh();}}
    async function more(){if(!owner||!detail?.nextCursor||!selected)return;try{const d=await profileRequest(owner,`/guardians/${selected}?before=${detail.nextCursor}`) as GuardianDetail;if(live(owner)&&selectedRef.current===selected)setDetail({...d,results:[...detail.results,...d.results.filter(r=>!detail.results.some(old=>old.id===r.id))]});}catch{setError(ko?'이전 기록을 불러오지 못했어요.':'Could not load earlier results.');}}
    async function wallet(){
        if(!owner)throw Error('wallet_changed');
        assertNftTransactionStorage(owner);
        if(!connector||!sameAddress(address??'',owner))throw Error('wallet_changed');
        if(await connector.getChainId()!==GUARDIAN_CHAIN_ID)await switchChainAsync({chainId:GUARDIAN_CHAIN_ID,connector});
        const w=await getConnectorClient(config,{connector,account:owner,chainId:GUARDIAN_CHAIN_ID});
        if(!alive.current||identity.current.uid!==connector.uid||!sameAddress(identity.current.address??'',owner))throw Error('wallet_changed');
        return w;
    }
    async function recorded(hash:Hex,kind:NftTransaction['kind'],tokenId?:string){
        if(!owner||!roster?.collection)throw Error('collection');
        let tx:NftTransaction={owner,collection:roster.collection,hash,kind,...(tokenId?{tokenId}:{})};
        setTransaction(tx);saveNftTransaction(tx);setPhase(ko?'GIWA 확인 중…':'Confirming on GIWA…');
        // The wallet may choose a nonce, so record the actual submitted transaction, never a guess.
        try{const submitted=await publicClient.getTransaction({hash});verifyReplacement(owner,submitted.nonce,submitted);tx={...tx,nonce:submitted.nonce};saveNftTransaction(tx);setTransaction(tx);}catch{/* The hash remains recoverable while the RPC catches up. */}
        let cancelled=false;
        const receipt=await publicClient.waitForTransactionReceipt({hash,timeout:60000,onReplaced:replacement=>{
            verifyReplacement(owner,tx.nonce??replacement.replacedTransaction.nonce,replacement.transaction);
            tx={...tx,hash:replacement.transaction.hash,nonce:replacement.transaction.nonce};saveNftTransaction(tx);setTransaction(tx);cancelled=replacement.reason==='cancelled';
        }});
        if(receipt.status!=='success'){clearNftTransaction(owner);setTransaction(null);throw Error('reverted');}
        clearNftTransaction(owner);setTransaction(null);if(cancelled)throw Error('cancelled');await refresh();
    }
    async function perform(action:()=>Promise<void>){if(locked.current||!owner)return;trackEngagement({event:'operator_action',locale:ko?'ko':'en'});locked.current=true;setBusy(true);setError('');loadFailed.current=false;setPhase(ko?'지갑에서 확인해 주세요':'Confirm in your wallet');try{await action();}catch(e){const code=giwaWalletError(e)?.code;const reason=e instanceof Error?e.message:'';setError(code==='rejected'?(ko?'지갑 요청을 취소했어요. 다시 시도할 수 있어요.':'Wallet request cancelled. You can try again.')
        :reason==='batch_unavailable'?(ko?'한 번에 기록하기는 전령 컨트랙트 업그레이드 뒤에 열려요. 업그레이드가 끝나면 다시 시도해 주세요.':'Recording in one go opens after the guardian contract upgrade. Try again once it lands.')
        :reason==='claims_waiting'?(ko?'아직 GIWA에서 확정되지 않은 모험이에요. 몇 분 뒤 다시 기록해 주세요.':'These outings are not final on GIWA yet. Record them again in a few minutes.')
        :e instanceof ProfileError&&e.code==='rate_limited'?(ko?'요청이 많아요. 잠시 후 다시 시도해 주세요.':'Too many requests. Try again shortly.')
        :(ko?'완료를 확인하지 못했어요. 아래 트랜잭션과 전령 상태를 새로고침해 주세요. 새 결제나 재추첨을 자동으로 요청하지 않아요.':'Completion is not confirmed. Check the transaction and refresh your guardian. Nothing is paid or redrawn automatically.'));}finally{locked.current=false;if(alive.current){setBusy(false);setPhase('');}await refresh();}}
    async function mint(){await perform(async()=>{
        if(!owner||!roster?.enabled||!roster.collection||paused||transaction)throw Error('mint_unavailable');
        const w=await wallet();
        const [oracle,provider,fee]=await Promise.all([
            publicClient.readContract({address:roster.collection,abi:guardianAbi,functionName:'entropy'}),
            publicClient.readContract({address:roster.collection,abi:guardianAbi,functionName:'entropyProvider'}),
            publicClient.readContract({address:roster.collection,abi:guardianAbi,functionName:'mintFee'}),
        ]);
        if(!sameAddress(oracle,GUARDIAN_ENTROPY)||!sameAddress(provider,GUARDIAN_PROVIDER))throw Error('collection');
        const contribution=bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
        const simulation=await publicClient.simulateContract({address:roster.collection,abi:guardianAbi,functionName:'mint',args:[contribution,fee],value:fee,account:owner});
        await wallet();const hash=await writeContract(w,simulation.request);await recorded(hash,'mint');
    });}
    /** Records the oldest unclaimed results (one contract batch) in a single transaction; the rest wait for the next batch. */
    async function claimAll(){await perform(async()=>{
        if(!owner||!roster?.collection||!detail||transaction)throw Error('claim_unavailable');
        const collection=roster.collection,token=detail.guardian;
        // An implementation without claimResults reverts this read: report the pending upgrade, never fall back.
        try{await publicClient.readContract({address:collection,abi:guardianAbi,functionName:'MAX_CLAIM_BATCH'});}
        catch(e){if(e instanceof BaseError&&e.walk(x=>x instanceof ContractFunctionRevertedError||x instanceof ContractFunctionZeroDataError))throw Error('batch_unavailable');throw e;}
        setPhase(ko?'기록할 모험에 서명 받는 중…':'Collecting signed results…');
        const batch=await profileRequest(owner,`/guardians/${token.tokenId}/claims`,'POST') as GuardianClaimBatch;
        const signer=await publicClient.readContract({address:collection,abi:guardianAbi,functionName:'resultSigner'});
        const {results,signatures}=await verifiedClaims(batch,{collection,signer,token,known:detail.results});
        if(!results.length)throw Error('claims_waiting');
        setPhase(ko?'지갑에서 확인해 주세요':'Confirm in your wallet');
        const w=await wallet();const simulation=await publicClient.simulateContract({address:collection,abi:guardianAbi,functionName:'claimResults',args:[results,signatures],account:owner});
        await wallet();await recorded(await writeContract(w,simulation.request),'claim',token.tokenId);
    });}
    async function recover(token:GuardianToken){await perform(async()=>{
        if(!owner||!roster?.collection||token.revealed||transaction)throw Error('not_pending');
        const request=await publicClient.readContract({address:GUARDIAN_ENTROPY,abi:entropyRecoveryAbi,functionName:'getRequestV2',args:[GUARDIAN_PROVIDER,BigInt(token.sequence)]});
        if(!sameAddress(request.requester,roster.collection)||!sameAddress(request.provider,GUARDIAN_PROVIDER)||request.sequenceNumber!==BigInt(token.sequence)||request.useBlockhash)throw Error('request_mismatch');
        // The latest request is either the mint or a re-request after an oracle change; both carry the contribution.
        const filter={address:roster.collection,args:{owner,tokenId:BigInt(token.tokenId),sequence:BigInt(token.sequence)},fromBlock:request.blockNumber,toBlock:request.blockNumber};
        const logs=(await Promise.all([
            publicClient.getLogs({...filter,event:parseAbiItem('event MintRequested(address indexed owner,uint256 indexed tokenId,uint64 indexed sequence,bytes32 contribution)')}),
            publicClient.getLogs({...filter,event:parseAbiItem('event BirthRerequested(address indexed owner,uint256 indexed tokenId,uint64 indexed sequence,bytes32 contribution)')}),
        ])).flat();
        const contribution=logs[0]?.args.contribution;if(logs.length!==1||!contribution)throw Error('request_missing');
        const response=await fetch(`https://fortuna-staging.dourolabs.app/v1/chains/giwa-testnet/revelations/${token.sequence}?block_number=${request.blockNumber}`,{signal:AbortSignal.timeout(15000),redirect:'error'});
        if(!response.ok)throw Error('provider_pending');
        const payload=await response.json() as {value?:{data?:unknown;encoding?:unknown}};
        const data=payload.value?.data;if(payload.value?.encoding!=='hex'||typeof data!=='string')throw Error('provider_response');
        const proof=verifyRevelation(contribution,data.startsWith('0x')?data:`0x${data}`,request.numHashes,request.commitment);
        const w=await wallet();const simulation=await publicClient.simulateContract({address:GUARDIAN_ENTROPY,abi:entropyRecoveryAbi,functionName:'revealWithCallback',args:[GUARDIAN_PROVIDER,BigInt(token.sequence),contribution,proof],account:owner});
        await wallet();await recorded(await writeContract(w,simulation.request),'recovery',token.tokenId);
    });}
    async function checkTransaction(replacementHash?:string){if(!transaction)return;await perform(async()=>{
        if(!owner)throw Error('wallet_changed');
        let tx=transaction;
        if(replacementHash){
            if(!isHash(replacementHash))throw Error('replacement_hash');
            const original=tx.nonce===undefined?await publicClient.getTransaction({hash:tx.hash}):null;
            if(original&&!sameAddress(original.from,owner))throw Error('replacement_owner');
            const nonce=tx.nonce??original!.nonce;
            const replacement=await publicClient.getTransaction({hash:replacementHash});verifyReplacement(owner,nonce,replacement);
            tx={...tx,hash:replacementHash,nonce};saveNftTransaction(tx);setTransaction(tx);
        }
        const receipt=await publicClient.getTransactionReceipt({hash:tx.hash});clearNftTransaction(owner);setTransaction(null);if(receipt.status!=='success')throw Error('reverted');
    });}
    return {roster,detail,selected,select,more,refresh,mint,claimAll,recover,checkTransaction,transaction,error,busy,phase,loading,paused};
}
