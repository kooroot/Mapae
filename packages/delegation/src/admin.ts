import {encodeFunctionData, getAddress, parseAbi, type Address, type Hex} from "viem";

const OWNABLE_TWO_STEP_ABI = parseAbi(["function acceptOwnership()"]);

/** Wallet transaction requested after the deployer nominates the Framework admin. */
export function buildFrameworkOwnershipAcceptance(
    delegationManager: Address,
): {to: Address; data: Hex; value: 0n} {
    return {
        to: getAddress(delegationManager),
        data: encodeFunctionData({
            abi: OWNABLE_TWO_STEP_ABI,
            functionName: "acceptOwnership",
        }),
        value: 0n,
    };
}
