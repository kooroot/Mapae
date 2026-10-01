import type {Config, Connector} from "wagmi";
import {getConnectorClient} from "wagmi/actions";
import {BaseError, type Address} from "viem";
import {signTypedData} from "viem/actions";
import {giwaSepolia} from "@mapae/shared";
import type {RootDelegationTypedData} from "@mapae/delegation/signing";

export class GiwaWalletError extends Error {
    constructor(readonly code: "timeout" | "chain" | "pending" | "rejected") {super(code);}
}

/** A late wallet response must not resume account deployment after this UI gave up. */
export function waitForWallet<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => {signal.removeEventListener("abort", abort); reject(new GiwaWalletError("timeout"));};
        signal.addEventListener("abort", abort, {once: true});
        if (signal.aborted) abort();
        request.then(value => {
            signal.removeEventListener("abort", abort);
            if (!signal.aborted) resolve(value);
        }, error => {
            signal.removeEventListener("abort", abort);
            reject(error);
        });
    });
}

export async function requestGiwaSignature(params: {
    config: Config; connector: Connector; owner: Address; typedData: RootDelegationTypedData;
    signal: AbortSignal; onRequest: () => void;
}) {
    if (params.typedData.domain.chainId !== giwaSepolia.id) throw new GiwaWalletError("chain");
    if (params.signal.aborted) throw new GiwaWalletError("timeout");
    // Pin both the selected provider and the live chain, rather than trusting the
    // cached account's chain or whichever extension last replaced window.ethereum.
    const client = await waitForWallet(getConnectorClient(params.config, {
        connector: params.connector, account: params.owner, chainId: giwaSepolia.id,
    }), params.signal);
    if (params.signal.aborted) throw new GiwaWalletError("timeout");
    params.onRequest();
    return waitForWallet(signTypedData(client, {...params.typedData, account: params.owner}), params.signal);
}

export function giwaWalletError(error: unknown): GiwaWalletError | null {
    if (error instanceof GiwaWalletError) return error;
    if (error instanceof Error && error.name === "ConnectorChainMismatchError") return new GiwaWalletError("chain");
    const cause = error instanceof BaseError ? error.walk(e => typeof e === "object" && e !== null && "code" in e) : error;
    if (typeof cause === "object" && cause !== null && "code" in cause) {
        if (cause.code === 4001) return new GiwaWalletError("rejected");
        if (cause.code === -32002) return new GiwaWalletError("pending");
    }
    return null;
}
