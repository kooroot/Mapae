import type {OutingView} from '@mapae/arcade/outings';
import type {GuardianSnapshot} from '@mapae/arcade/guardians';

export type GuardianIdentity=Pick<GuardianSnapshot,'collection'|'tokenId'|'ownershipEpoch'>;
/** A previous owner's/epoch's pending payment is recoverable, but cannot lock this ownership. */
export function activeGuardianOuting(job:OutingView,identity:GuardianIdentity):boolean {
    return ['queued','running','paused'].includes(job.status)&&job.guardian.tokenId===identity.tokenId&&
        job.guardian.collection.toLowerCase()===identity.collection.toLowerCase()&&job.guardian.ownershipEpoch===identity.ownershipEpoch;
}
