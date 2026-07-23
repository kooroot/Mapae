import {DeleGatorCore, DelegationManager} from "@metamask/smart-accounts-kit/contracts";
import {hashDelegation} from "@metamask/smart-accounts-kit/utils";
import type {Delegation} from "@metamask/smart-accounts-kit";
import {getAddress, type Address, type Hex, type PublicClient} from "viem";

export interface RevocationCall {
    to: Address;
    value: 0n;
    data: Hex;
}

/**
 * Build the owner smart-account call used to revoke a delegation.
 *
 * `DeleGatorCore.disableDelegation` is only callable through the account itself or
 * EntryPoint, so this call must be wrapped in an owner-authorized UserOperation.
 * It must never be sent directly from the relayer to DelegationManager.
 */
export function buildRevocationCall(delegation: Delegation): RevocationCall {
    return {
        to: getAddress(delegation.delegator),
        value: 0n,
        data: DeleGatorCore.encode.disableDelegation({delegation}),
    };
}

export async function isDelegationRevoked(params: {
    publicClient: PublicClient;
    delegationManager: Address;
    delegation: Delegation;
}): Promise<boolean> {
    return DelegationManager.read.disabledDelegations({
        client: params.publicClient,
        contractAddress: params.delegationManager,
        delegationHash: hashDelegation(params.delegation),
    });
}
