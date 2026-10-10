import type {Database} from 'bun:sqlite';
import {keccak256, stringToHex, type Address, type Hex} from 'viem';
import type {OutingResult} from '@mapae/arcade/outings';
import type {Job} from '../outings/store';
import {OutingError} from '../outings/validation';
import {emptyProgress, type Progress, type ReceiptEvidence, type ResultJson, type VerifiedResult} from './types';

export type StoredResult = {
    result: ResultJson; outcome: OutingResult; collection: Address; payer: Address; inputs: string;
    evidence: ReceiptEvidence | null; signature: Hex | null; signer: Address | null;
};
export const resultId = (job: Job): Hex => keccak256(stringToHex(JSON.stringify([job.guardian.chainId, job.guardian.collection.toLowerCase(), job.id, job.spent + 1])));
export function resultInputs(job: Job): string {
    return JSON.stringify({guardian: job.guardian, profile: job.profile, locale: job.locale, game: job.pending!.game,
        seed: job.pending!.seed, shopMemory: job.shopMemory ?? null});
}
export class GuardianLedger {
    constructor(readonly db: Database) {
        db.exec(`CREATE TABLE IF NOT EXISTS arcade_guardian_results (
            result_id TEXT PRIMARY KEY, token_id TEXT NOT NULL, collection TEXT NOT NULL, actor TEXT NOT NULL,
            outing_id TEXT NOT NULL, admission INTEGER NOT NULL, payment_tx TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(outing_id, admission));
            CREATE INDEX IF NOT EXISTS guardian_results_token ON arcade_guardian_results(collection,token_id,created_at);
            CREATE INDEX IF NOT EXISTS guardian_results_actor ON arcade_guardian_results(actor,created_at);`);
    }
    get(id: string): StoredResult | null {
        const row = this.db.query<{data: string}, [string]>('SELECT data FROM arcade_guardian_results WHERE result_id=?').get(id.toLowerCase());
        return row ? JSON.parse(row.data) : null;
    }
    /** Called INSIDE the outing advancement transaction, never as a separate commit. */
    insert(job: Job, outcome: OutingResult): void {
        if (!job.pending || outcome.transaction !== job.pending.transaction || outcome.seed !== job.pending.seed ||
            outcome.game !== job.pending.game || outcome.id !== resultId(job) ||
            outcome.outcome.game !== outcome.game || outcome.outcome.replay?.version !== job.guardian.ruleset ||
            outcome.outcome.replay?.seed !== outcome.seed || typeof outcome.outcome.achievement?.victory !== 'boolean' ||
            !Number.isSafeInteger(outcome.outcome.score) || outcome.outcome.score < 0 || outcome.outcome.score > 1_000_000_000) throw new OutingError('result_unavailable');
        const inputs = resultInputs(job);
        const result: ResultJson = {
            resultId: outcome.id as Hex, tokenId: job.guardian.tokenId, actor: job.owner, ownershipEpoch: job.guardian.ownershipEpoch,
            paymentTx: outcome.transaction.toLowerCase() as Hex, traitsHash: job.guardian.traitsHash,
            inputsHash: keccak256(stringToHex(inputs)), ruleset: job.guardian.ruleset, seed: outcome.seed,
            game: ['stamp','race','shop'].indexOf(outcome.game), score: outcome.outcome.score, victory: outcome.outcome.achievement.victory,
        };
        const data: StoredResult = {result, outcome, collection: job.guardian.collection, payer: job.payer, inputs, evidence: null, signature: null, signer: null};
        this.db.query('INSERT INTO arcade_guardian_results VALUES (?,?,?,?,?,?,?,?,?)')
            .run(result.resultId.toLowerCase(), result.tokenId, data.collection.toLowerCase(), result.actor.toLowerCase(), job.id, job.spent + 1, result.paymentTx, outcome.at, JSON.stringify(data));
    }
    attest(id: string, evidence: ReceiptEvidence, signer: Address, signature: Hex): void {
        const row = this.get(id); if (!row) throw new OutingError('not_found');
        row.evidence = evidence; row.signer = signer; row.signature = signature;
        this.db.query('UPDATE arcade_guardian_results SET data=? WHERE result_id=?').run(JSON.stringify(row), id.toLowerCase());
    }
    list(collection: Address, tokenId: string, before?: string): StoredResult[] {
        // Stable rowid cursor survives equal timestamps. Only bounded indexed pages leave the server.
        const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
        if (!Number.isSafeInteger(cursor) || cursor <= 0) throw new OutingError('invalid_request');
        return this.db.query<{data: string}, [string,string,number]>(
            'SELECT data FROM arcade_guardian_results WHERE collection=? AND token_id=? AND rowid<? ORDER BY rowid DESC LIMIT 40')
            .all(collection.toLowerCase(), tokenId, cursor).map(r => JSON.parse(r.data));
    }
    cursor(id: string): string {
        return String(this.db.query<{cursor: number}, [string]>('SELECT rowid AS cursor FROM arcade_guardian_results WHERE result_id=?').get(id.toLowerCase())!.cursor);
    }
    progress(collection: Address, tokenId: string): Progress {
        const result = emptyProgress();
        const rows = this.db.query<{game: number; plays: number; victories: number; best: number}, [string,string]>(
            `SELECT json_extract(data,'$.result.game') AS game, COUNT(*) AS plays,
                SUM(json_extract(data,'$.result.victory')) AS victories, MAX(json_extract(data,'$.result.score')) AS best
                FROM arcade_guardian_results WHERE collection=? AND token_id=? GROUP BY game`).all(collection.toLowerCase(), tokenId);
        for (const row of rows) {
            result.games[row.game] = {plays: row.plays, victories: row.victories, bestScore: row.best};
            result.plays += row.plays; result.victories += row.victories;
        }
        result.experience = result.plays * 10 + result.victories * 5; result.level = 1 + Math.floor(result.experience / 100);
        return result;
    }
    memory(collection: Address, tokenId: string) {
        const row = this.db.query<{data:string},[string,string]>(`SELECT data FROM arcade_guardian_results
            WHERE collection=? AND token_id=? AND json_extract(data,'$.outcome.game')='shop' ORDER BY rowid DESC LIMIT 1`).get(collection.toLowerCase(), tokenId);
        return row ? (JSON.parse(row.data) as StoredResult).outcome.outcome.shopMemory : undefined;
    }
    metrics(since: number): {operators: number; completedAdmissions: number; paymentTransactions: number; victories: number} {
        return this.db.query<{operators:number;completedAdmissions:number;paymentTransactions:number;victories:number},[number]>(
            `SELECT COUNT(DISTINCT actor) AS operators, COUNT(*) AS completedAdmissions, COUNT(DISTINCT payment_tx) AS paymentTransactions,
            COALESCE(SUM(json_extract(data,'$.result.victory')),0) AS victories FROM arcade_guardian_results WHERE created_at>=?`).get(since)!;
    }
}
/** Token-public gameplay excludes the previous owner's payment and identity history. */
export function resultView(row: StoredResult, viewer: Address, claimed: boolean): VerifiedResult {
    const own = viewer.toLowerCase() === row.result.actor.toLowerCase();
    return {...row.outcome, transaction: own ? row.outcome.transaction : null, tokenId: row.result.tokenId, actor: own ? row.result.actor : null, ownershipEpoch: row.result.ownershipEpoch,
        ruleset: row.result.ruleset, score: row.result.score, victory: row.result.victory, claimed};
}
