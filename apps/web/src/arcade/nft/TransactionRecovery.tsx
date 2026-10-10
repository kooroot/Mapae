import {useState} from 'react';
import {explorerTxUrl} from '../../lib/config';
import type {NftTransaction} from './transaction-store';

export function TransactionRecovery({transaction,busy,ko,onCheck}:{transaction:NftTransaction;busy:boolean;ko:boolean;onCheck:(replacementHash?:string)=>Promise<void>}){
    const [replacement,setReplacement]=useState('');
    return <section className="nft-panel" role="status"><p>{ko?'전송한 트랜잭션의 결과를 확인해 주세요.':'Check the transaction already submitted.'}</p>
        <a href={explorerTxUrl(transaction.hash)} target="_blank" rel="noreferrer">{ko?'GIWA 영수증 보기':'View GIWA receipt'}</a>
        <button className="arc-text-button" disabled={busy} onClick={()=>void onCheck()}>{ko?'같은 트랜잭션 확인':'Check this transaction'}</button>
        <details className="nft-replacement"><summary>{ko?'지갑에서 속도를 높이거나 취소했나요?':'Sped up or cancelled in your wallet?'}</summary>
            <p>{ko?'지갑에 표시된 대체 트랜잭션 해시를 입력하세요. 같은 지갑·같은 거래 순번인지 GIWA에서 확인해요.':'Paste the replacement transaction hash shown in your wallet. GIWA must confirm the same sender and nonce.'}</p>
            <label>{ko?'대체 트랜잭션 해시':'Replacement transaction hash'}<input value={replacement} onChange={e=>setReplacement(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false}/></label>
            <button className="arc-text-button" disabled={busy||!/^0x[\da-fA-F]{64}$/.test(replacement)} onClick={()=>void onCheck(replacement)}>{ko?'대체 거래 확인':'Check replacement'}</button>
        </details>
    </section>;
}
