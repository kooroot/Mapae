import {validateAccountBootstrap} from '@mapae/delegation/account-bootstrap';
import {parseActiveDeploymentArtifactJson, MAX_PERMISSION_CONTEXT_HEX_LENGTH} from '@mapae/delegation/config';
import {decodeTimestampTerms} from '@mapae/delegation/delegation-status';
import {buildRootDelegationTypedData} from '@mapae/delegation/signing';
import {preparePeriodDelegation} from '@mapae/delegation/policy';
import {ARCADE_PAY_TO, ARCADE_TICKET_AMOUNT} from '@mapae/arcade/tickets';
import {GUARDIAN_MAX_SUPPLY} from '@mapae/arcade/guardians';
import {MAX_OUTING_ADMISSIONS, OUTING_PERMISSION_SECONDS, type OutingStart} from '@mapae/arcade/outings';
import {MOCK_USDC} from '@mapae/shared';
import {getAddress, isHex, hashTypedData, type Address, type Hex} from 'viem';
import artifact from '../../../deployments/giwa-sepolia.framework.json';

export const deployment = parseActiveDeploymentArtifactJson(JSON.stringify(artifact));
export const ID = /^[A-Za-z0-9_-]{8,80}$/;
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export class OutingError extends Error {
    constructor(readonly code: 'disabled' | 'unauthorized' | 'invalid_request' | 'invalid_permission' | 'conflict' | 'not_found' | 'busy' | 'storage_unavailable' | 'owner_changed' | 'guardian_unavailable' | 'result_unavailable' | 'receipt_unconfirmed') {super(code);}
}
const member = (v: unknown, items: readonly string[]) => typeof v === 'string' && items.includes(v);
const TOKEN_ID = /^[1-9][0-9]{0,4}$/;
/** Guardian IDs are drawn from 1..GUARDIAN_MAX_SUPPLY, and every name is derived from one. */
export function validTokenId(value: unknown): value is string {
    return typeof value === 'string' && TOKEN_ID.test(value) && Number(value) <= GUARDIAN_MAX_SUPPLY;
}
export function parseStart(input: unknown): OutingStart {
    if (!object(input) || Object.keys(input).some(k => !['id','tokenId','goal','locale','choice','admissions','permissionContext'].includes(k)) ||
        typeof input.id !== 'string' || !ID.test(input.id) || !validTokenId(input.tokenId) ||
        !member(input.goal, ['score','save','explore']) || !member(input.locale, ['ko','en']) || !member(input.choice, ['auto','stamp','race','shop']) ||
        !Number.isSafeInteger(input.admissions) || Number(input.admissions) < 1 || Number(input.admissions) > MAX_OUTING_ADMISSIONS ||
        typeof input.permissionContext !== 'string' || !isHex(input.permissionContext) || input.permissionContext.length % 2 !== 0 ||
        input.permissionContext.length < 4 || input.permissionContext.length > MAX_PERMISSION_CONTEXT_HEX_LENGTH) throw new OutingError('invalid_request');
    return input as OutingStart;
}
export type ValidatedPermission = {payer: Address; expiresAt: number; contextHash: Hex};
export async function validatePermission(owner: Address, start: OutingStart, agent: Address, now: number): Promise<ValidatedPermission> {
    try {
        const verified = await validateAccountBootstrap({permissionContext: start.permissionContext}, {environment: deployment.environment, approval: ''});
        const grant = verified.delegation;
        if (getAddress(verified.owner) !== getAddress(owner) || getAddress(grant.delegate) !== agent) throw new Error();
        const timestamp = grant.caveats.find(c => getAddress(c.enforcer) === getAddress(deployment.environment.caveatEnforcers.TimestampEnforcer!));
        if (!timestamp) throw new Error();
        const {notBefore, notAfter} = decodeTimestampTerms(timestamp.terms);
        const startDate = Number(notBefore), expiresAt = Number(notAfter) * 1000;
        if (!Number.isSafeInteger(startDate) || startDate * 1000 > now + 30_000 || expiresAt <= now + 30_000 ||
            notAfter - notBefore !== BigInt(OUTING_PERMISSION_SECONDS) || startDate * 1000 < now - 300_000) throw new Error();
        const expected = preparePeriodDelegation({environment: deployment.environment, delegator: verified.account, delegate: agent,
            startDate, salt: grant.salt as Hex, policy: {role: 'vendor-agent', token: MOCK_USDC.address,
                periodAmount: BigInt(start.admissions) * ARCADE_TICKET_AMOUNT, lifetimeTotalAmount: BigInt(start.admissions) * ARCADE_TICKET_AMOUNT,
                periodDurationSeconds: 60, expiresAfterSeconds: OUTING_PERMISSION_SECONDS, recipient: ARCADE_PAY_TO}});
        if (grant.authority !== expected.authority || grant.caveats.length !== expected.caveats.length ||
            grant.caveats.some((c, i) => c.enforcer.toLowerCase() !== expected.caveats[i]!.enforcer.toLowerCase() ||
                c.terms.toLowerCase() !== expected.caveats[i]!.terms.toLowerCase() || c.args.toLowerCase() !== expected.caveats[i]!.args.toLowerCase())) throw new Error();
        return {payer: verified.account, expiresAt, contextHash: hashTypedData(buildRootDelegationTypedData(deployment.environment.DelegationManager, grant))};
    } catch {throw new OutingError('invalid_permission');}
}
