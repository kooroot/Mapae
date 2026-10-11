import {Database} from 'bun:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import type {Address, Hex} from 'viem';
import {ARCADE_RULESET_VERSION} from '@mapae/arcade';
import {guardianName, guardianTraits, guardianTraitsHash, type GuardianSnapshot} from '@mapae/arcade/guardians';
import {GuardianLedger} from '../guardians/ledger';
import type {GameId} from '@mapae/arcade';
import type {ShopMemory} from '@mapae/arcade/shop';
import type {OutingStart, OutingView, OutingResult} from '@mapae/arcade/outings';
import {RANKED_GAMES, type RankedAttempt} from '@mapae/arcade/ranking';
import {OutingError, type ValidatedPermission} from './validation';

/** `ranked` is fixed when the admission is created, so a round that crosses midnight keeps the day it was drawn for. */
export type Pending = {game: GameId; seed: number; header: string | null; transaction: Hex | null; ranked?: RankedAttempt};
export type Job = Omit<OutingView, 'reservedAdmissions'> & {owner: Address; payer: Address; agent: Address; context: Hex; fingerprint: string; contextHash: Hex; stopRequested: boolean; pending: Pending | null; shopMemory?: ShopMemory};
export function publicJob(job: Job): OutingView {
    const {id, characterId, guardian, profile, locale, choice, status, admissions, spent, createdAt, updatedAt, expiresAt, error, results} = job;
    const charged = spent + (job.pending?.transaction ? 1 : 0);
    const reservedAdmissions = status === 'complete' || status === 'stopped' ? 0 : job.stopRequested
        ? (job.pending?.header && !job.pending.transaction ? 1 : 0) : admissions - charged;
    return {id, characterId, guardian, profile, locale, choice, status, admissions, spent: charged, reservedAdmissions, createdAt, updatedAt, expiresAt, error, results};
}
// Canonical field order avoids a JSON property order becoming a second idempotency key.
export function fingerprint(owner: Address, start: OutingStart): string {
    return createHash('sha256').update(JSON.stringify([owner.toLowerCase(), start.tokenId, start.goal,
        start.locale, start.choice, start.admissions, start.permissionContext.toLowerCase()])).digest('hex');
}
export class OutingStore {
    readonly db: Database;
    readonly guardians: GuardianLedger;
    readonly workerId = randomUUID();
    constructor(path: string) {
        this.db = new Database(path, {create: true, strict: true});
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS arcade_outings(id TEXT PRIMARY KEY, owner TEXT NOT NULL, context_hash TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS arcade_outings_owner ON arcade_outings(owner, updated_at);
            CREATE TABLE IF NOT EXISTS arcade_outing_lease(id INTEGER PRIMARY KEY CHECK(id=1), worker TEXT NOT NULL, until_ms INTEGER NOT NULL);`);
        if (this.db.query("SELECT id FROM arcade_outings WHERE state IN ('queued','running','paused') AND json_extract(data,'$.guardian') IS NULL LIMIT 1").get()) throw new Error('Drain previous mutable-character outings before guardian rollout');
        this.guardians = new GuardianLedger(this.db);
    }
    get(id: string): Job | null {const row = this.db.query<{data: string}, [string]>('SELECT data FROM arcade_outings WHERE id=?').get(id); return row ? JSON.parse(row.data) as Job : null;}
    list(owner: Address): Job[] {return this.db.query<{data: string}, [string]>("SELECT data FROM arcade_outings WHERE owner=? AND json_extract(data,'$.guardian') IS NOT NULL ORDER BY CASE WHEN state IN ('queued','running','paused') THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 24").all(owner.toLowerCase()).map(r => JSON.parse(r.data) as Job);}
    save(job: Job): void {this.db.query('UPDATE arcade_outings SET updated_at=?, state=?, data=? WHERE id=?').run(job.updatedAt, job.status, JSON.stringify(job), job.id);}
    insert(owner: Address, start: OutingStart, permission: ValidatedPermission, agent: Address, now: number, guardian: GuardianSnapshot): Job {
        return this.db.transaction(() => {
            const prior = this.get(start.id), hash = fingerprint(owner, start);
            if (prior) {if (prior.fingerprint !== hash) throw new OutingError('conflict'); return prior;}
            if (guardian.owner.toLowerCase() !== owner.toLowerCase() || guardian.tokenId !== start.tokenId) throw new OutingError('owner_changed');
            if (guardian.ruleset !== ARCADE_RULESET_VERSION || guardian.traitsHash !== guardianTraitsHash(guardian.seed)) throw new OutingError('guardian_unavailable');
            const traits = guardianTraits(guardian.seed);
            const characterId = `nft-${start.tokenId}`;
            // The Korean name is canonical for every stored profile: locale-independent and within the 12-character agent profile bound.
            const profile = {name: guardianName(start.tokenId, 'ko'), color: traits.color, temperament: traits.temperament, goal: start.goal, aptitudes: traits.aptitudes};
            this.expireUnsubmitted(now);
            const tokenJobs = this.db.query<{data: string}, [string, string]>("SELECT data FROM arcade_outings WHERE lower(json_extract(data, '$.guardian.collection'))=? AND json_extract(data, '$.guardian.tokenId')=? AND state IN ('queued','running','paused')").all(guardian.collection.toLowerCase(), guardian.tokenId).map(row => JSON.parse(row.data) as Job);
            // Check every row first: an older recovery row must not hide the current
            // epoch's active operation from a second device.
            if (tokenJobs.some(previous => BigInt(previous.guardian.ownershipEpoch) > BigInt(guardian.ownershipEpoch))) throw new OutingError('owner_changed');
            if (tokenJobs.some(previous => previous.guardian.ownershipEpoch === guardian.ownershipEpoch)) throw new OutingError('busy');
            for (const previous of tokenJobs) {
                // Transfer never makes the buyer depend on an unavailable old owner.
                // Retain exact submitted payments with their actor; they may finish once,
                // but cannot create another admission or acquire the buyer's authority.
                previous.stopRequested = true;
                if (!previous.pending?.header && !previous.pending?.transaction) {
                    previous.status = 'stopped'; previous.context = '0x'; previous.pending = null;
                }
                previous.error = 'owner_changed'; previous.updatedAt = now; this.save(previous);
            }
            const active = this.db.query<{n: number}, [string]>("SELECT COUNT(*) n FROM arcade_outings WHERE owner=? AND state IN ('queued','running','paused') AND json_extract(data,'$.stopRequested')=0").get(owner.toLowerCase())!.n;
            const total = this.db.query<{n: number}, []>("SELECT COUNT(*) n FROM arcade_outings WHERE state IN ('queued','running','paused')").get()!.n;
            if (active >= 3 || total >= 256) throw new OutingError('busy');
            if (this.db.query('SELECT id FROM arcade_outings WHERE context_hash=?').get(permission.contextHash)) throw new OutingError('conflict');
            const job: Job = {id: start.id, owner, payer: permission.payer, agent, context: start.permissionContext, contextHash: permission.contextHash,
                fingerprint: hash, characterId, guardian, profile, locale: start.locale, choice: start.choice,
                admissions: start.admissions, spent: 0, status: 'queued', createdAt: now, updatedAt: now, expiresAt: permission.expiresAt,
                error: null, stopRequested: false, pending: null, results: [], shopMemory: this.guardians.memory(guardian.collection, guardian.tokenId)};
            this.db.query('INSERT INTO arcade_outings VALUES (?,?,?,?,?,?)').run(job.id, owner.toLowerCase(), permission.contextHash, now, job.status, JSON.stringify(job));
            return job;
        }).immediate();
    }
    /**
     * Ranked attempts a guardian has used per game on a KST day: settled ranked rounds, plus admissions still pending in any
     * other active outing of the token (an earlier owner's recovery included). Counted per token, so a transfer resets nothing;
     * a pending admission cleared without payment frees its attempt. The runner is serial under the lease, so this cannot race.
     */
    rankedAttemptsUsed(collection: Address, tokenId: string, day: string, excludeJobId = ''): Record<GameId, number> {
        const used = Object.fromEntries(RANKED_GAMES.map(game => [game, 0])) as Record<GameId, number>;
        for (const row of this.db.query<{game: GameId; n: number}, [string, string, string]>(
            'SELECT game, COUNT(*) AS n FROM arcade_guardian_ranked WHERE collection=? AND token_id=? AND day=? GROUP BY game').all(collection.toLowerCase(), tokenId, day)) used[row.game] += row.n;
        for (const row of this.db.query<{game: GameId; n: number}, [string, string, string, string]>(
            `SELECT json_extract(data,'$.pending.game') AS game, COUNT(*) AS n FROM arcade_outings
                WHERE state IN ('queued','running','paused') AND lower(json_extract(data,'$.guardian.collection'))=? AND json_extract(data,'$.guardian.tokenId')=?
                AND id<>? AND json_extract(data,'$.pending.ranked.day')=? GROUP BY game`).all(collection.toLowerCase(), tokenId, excludeJobId, day)) used[row.game] += row.n;
        return used;
    }
    /** A bounded cleanup only retires expired work that never acquired a payment header.
     * Running senders are excluded; the lease-holding runner handles interrupted ones. */
    expireUnsubmitted(now: number): number {
        return this.db.query(`UPDATE arcade_outings SET state='stopped', updated_at=?,
            data=json_set(data, '$.status','stopped', '$.error','permission_expired', '$.context','0x', '$.pending',json('null'), '$.updatedAt',?)
            WHERE id IN (SELECT id FROM arcade_outings WHERE state IN ('queued','paused')
                AND json_extract(data,'$.expiresAt')<=?
                AND json_extract(data,'$.pending.header') IS NULL AND json_extract(data,'$.pending.transaction') IS NULL
                ORDER BY updated_at, id LIMIT 64)`).run(now, now, now).changes;
    }
    lease(now: number): boolean {
        this.db.query('INSERT INTO arcade_outing_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET worker=excluded.worker, until_ms=excluded.until_ms WHERE until_ms<=? OR worker=?')
            .run(this.workerId, now + 120_000, now, this.workerId);
        return this.db.query<{worker: string}, []>('SELECT worker FROM arcade_outing_lease WHERE id=1').get()?.worker === this.workerId;
    }
    release(): void {this.db.query('DELETE FROM arcade_outing_lease WHERE worker=?').run(this.workerId);}
    next(): Job | null {
        const row = this.db.query<{data: string}, []>("SELECT data FROM arcade_outings WHERE state IN ('running','queued') ORDER BY updated_at, id LIMIT 1").get();
        return row ? JSON.parse(row.data) as Job : null;
    }
    result(jobId: string, result: OutingResult, now: number): void {
        this.db.transaction(() => {
            const job = this.get(jobId)!;
            const existing = job.results.find(r => r.id === result.id);
            if (existing) {if (JSON.stringify(existing) !== JSON.stringify(result)) throw new OutingError('conflict'); return;}
            this.guardians.insert(job, result);
            job.results.push(result); if (result.outcome.shopMemory) job.shopMemory = result.outcome.shopMemory; job.spent = job.results.length; job.pending = null; job.updatedAt = now; job.error = null;
            job.status = job.stopRequested ? 'stopped' : job.spent >= job.admissions ? 'complete' : 'queued';
            if (job.status === 'complete' || job.status === 'stopped') job.context = '0x';
            this.save(job);
        }).immediate();
    }
    close(): void {this.release(); this.db.close();}
}
