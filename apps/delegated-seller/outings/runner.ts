import type {Address, Hex} from 'viem';
import {chooseOutingGame, runArcadeSimulation} from '@mapae/arcade/simulation';
import type {ActivityOutcome} from '@mapae/arcade';
import {OutingStore, type Job, type Pending} from './store';
import {OutingError} from './validation';
import {resultId} from '../guardians/ledger';
import type {GuardianReader} from '../guardians/types';
import {ARCADE_RULESET_VERSION} from '@mapae/arcade';

export interface OutingPayment {
    /** persist(header) must complete synchronously before any signed request leaves. */
    pay(job: Job, pending: Pending, persist: (header: string) => void): Promise<Hex>;
}
export class OutingRunner {
    private busy = false;
    private timer?: ReturnType<typeof setInterval>;
    constructor(readonly store: OutingStore, readonly agent: Address, readonly payment: OutingPayment, readonly guardians: Pick<GuardianReader, 'inspect'>,
        readonly now: () => number = Date.now,
        readonly simulate: typeof runArcadeSimulation = runArcadeSimulation) {}
    start(): void {this.timer ??= setInterval(() => {void this.tick().catch(() => {/* DB failure leaves durable intent recoverable. */});}, 2000); this.timer.unref();}
    stopPolling(): void {if (this.timer) clearInterval(this.timer); this.timer = undefined;}
    control(owner: Address, id: string, action: 'stop' | 'resume'): void {
        const job = this.store.get(id);
        if (!job || job.owner.toLowerCase() !== owner.toLowerCase()) throw new OutingError('not_found');
        if (job.status === 'complete' || job.status === 'stopped') return;
        if (action === 'stop') {
            job.stopRequested = true;
            // A paid or in-flight ticket finishes once; stopping never creates a replacement.
            if (job.status !== 'running') {
                if (job.pending?.header || job.pending?.transaction) job.status = 'queued';
                else {job.status = 'stopped'; job.context = '0x';}
            }
        } else {
            if (job.agent !== this.agent && !job.pending?.transaction) throw new OutingError('invalid_permission');
            if (!job.pending?.header && !job.pending?.transaction && job.expiresAt <= this.now()) throw new OutingError('invalid_permission');
            if (job.status === 'paused') {job.status = 'queued'; job.error = null;}
        }
        job.updatedAt = this.now(); this.store.save(job);
    }
    async tick(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        try {
            if (!this.store.lease(this.now())) return;
            heartbeat = setInterval(() => {try {this.store.lease(this.now());} catch { /* Before dispatch we recheck lease. */ }}, 10_000);
            this.store.expireUnsubmitted(this.now());
            const job = this.store.next();
            if (!job) return;
            if (!job.pending?.header && !job.pending?.transaction && job.expiresAt <= this.now()) {
                job.status = 'stopped'; job.error = 'permission_expired'; job.context = '0x'; job.pending = null;
                job.updatedAt = this.now(); this.store.save(job); return;
            }
            // An interrupted sender is quarantined on restart until the owner explicitly
            // resumes the same durable authorization. Never guess that the charge failed.
            if (job.status === 'running') {this.pause(job, 'payment_unresolved'); return;}
            if (job.agent !== this.agent && !job.pending?.transaction) {this.pause(job, 'key_changed'); return;}
            if (job.stopRequested && !job.pending?.header && !job.pending?.transaction) {job.status = 'stopped'; job.context = '0x'; job.updatedAt = this.now(); this.store.save(job); return;}
            // A different owner/epoch may never create another signed admission. Existing
            // headers are financial intents: reconcile them even after transfer or expiry.
            if (!job.pending?.header && !job.pending?.transaction) {
                try {
                    const current = await this.guardians.inspect(job.guardian.tokenId);
                    if (current.owner.toLowerCase() !== job.owner.toLowerCase() || current.ownershipEpoch !== job.guardian.ownershipEpoch ||
                        current.collection.toLowerCase() !== job.guardian.collection.toLowerCase() || current.seed !== job.guardian.seed) {
                        job.status = 'stopped'; job.context = '0x'; job.pending = null; job.error = 'owner_changed'; job.updatedAt = this.now(); this.store.save(job); return;
                    }
                } catch {this.pause(job, 'guardian_unavailable'); return;}
            }
            if (!job.pending?.header && !job.pending?.transaction && this.store.get(job.id)?.stopRequested) return;
            if (job.guardian.ruleset !== ARCADE_RULESET_VERSION) {this.pause(job, 'ruleset_changed'); return;}
            job.pending ??= {game: chooseOutingGame(job.profile, job.choice, job.results.map(r => r.game)), seed: crypto.getRandomValues(new Uint32Array(1))[0]!, header: null, transaction: null};
            job.status = 'running'; job.updatedAt = this.now(); this.store.save(job);
            try {
                if (!job.pending.transaction) {
                    if (!this.store.lease(this.now())) return;
                    job.pending.transaction = await this.payment.pay(job, job.pending, header => {
                        const current = this.store.get(job.id)!;
                        if (!this.store.lease(this.now()) || current.status !== 'running' || current.agent !== this.agent || current.stopRequested || current.expiresAt <= this.now()) throw new Error('dispatch_refused');
                        if (current.pending?.header && current.pending.header !== header) throw new Error('header_conflict');
                        current.pending!.header = header; current.updatedAt = this.now(); this.store.save(current);
                    });
                    const current = this.store.get(job.id)!;
                    current.pending!.transaction = job.pending.transaction; current.updatedAt = this.now(); this.store.save(current);
                }
                const latest = this.store.get(job.id)!;
                const outcome: ActivityOutcome = this.simulate({game: latest.pending!.game, seed: latest.pending!.seed,
                    profile: latest.profile, locale: latest.locale, shopMemory: latest.shopMemory});
                if (Buffer.byteLength(JSON.stringify(outcome), 'utf8') > 16_384) throw new Error('outcome_too_large');
                this.store.result(job.id, {id: resultId(latest), game: latest.pending!.game, seed: latest.pending!.seed,
                    at: this.now(), transaction: latest.pending!.transaction!, outcome}, this.now());
            } catch {
                const current = this.store.get(job.id)!;
                if (current.status === 'complete' || current.status === 'stopped') return;
                if (!current.pending?.header && !current.pending?.transaction && (current.stopRequested || current.expiresAt <= this.now())) {
                    current.status = 'stopped'; current.context = '0x'; current.pending = null; current.updatedAt = this.now();
                    current.error = current.expiresAt <= this.now() ? 'permission_expired' : null; this.store.save(current);
                } else this.pause(current, current.pending?.transaction ? 'simulation_failed' : 'payment_unresolved');
            }
        } finally {if (heartbeat) clearInterval(heartbeat); try {this.store.release();} finally {this.busy = false;}}
    }
    private pause(job: Job, error: string): void {
        const current = this.store.get(job.id);
        if (!current || current.status === 'complete' || current.status === 'stopped') return;
        if (current.stopRequested && !current.pending?.header && !current.pending?.transaction) {
            current.status = 'stopped'; current.context = '0x'; current.pending = null;
        } else current.status = 'paused';
        current.error = error; current.updatedAt = this.now(); this.store.save(current);
    }
}
