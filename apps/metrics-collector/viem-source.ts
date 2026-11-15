/**
 * The viem side of {@link ChainSource}. Event ABIs come from the Framework's own
 * interfaces — `REDEEMED_DELEGATION_EVENT` is the one `delegation-status.ts` already
 * decodes for grant recovery, the other two are copied verbatim from
 * `IDelegationManager.sol` and `SimpleFactory.sol`.
 */
import {REDEEMED_DELEGATION_EVENT} from "@mapae/delegation/delegation-status";
import {getAddress, parseAbiItem, type Address, type Hex, type PublicClient} from "viem";
import type {ChainSource, RawLink} from "./indexer";

export const DISABLED_DELEGATION_EVENT = parseAbiItem([
    "event DisabledDelegation(bytes32 indexed delegationHash, address indexed delegator, address indexed delegate, Delegation delegation)",
    "struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }",
    "struct Caveat { address enforcer; bytes terms; bytes args; }",
]);
export const SIMPLE_FACTORY_DEPLOYED_EVENT = parseAbiItem("event Deployed(address indexed addr)");

/** A pending log has no position; the indexer only reads finalized ranges, so one is a node fault. */
function position(log: {transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null}): RawLink {
    if (log.transactionHash === null || log.logIndex === null || log.blockNumber === null) throw new Error("log without a position in a finalized range");
    return {transactionHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber};
}

function present<T>(value: T | undefined, field: string): T {
    if (value === undefined) throw new Error(`log is missing ${field}`);
    return value;
}

export function viemChainSource(client: PublicClient, contracts: {delegationManager: Address; simpleFactory: Address}): ChainSource {
    return {
        async finalizedHead() {
            const block = await client.getBlock({blockTag: "finalized"});
            return {number: block.number, hash: block.hash, timestamp: block.timestamp};
        },
        async blockTimestamp(blockNumber) {
            return (await client.getBlock({blockNumber})).timestamp;
        },
        async receipt(hash) {
            const r = await client.getTransactionReceipt({hash});
            return {from: getAddress(r.from), blockNumber: r.blockNumber, logs: r.logs.map(l => ({address: getAddress(l.address), topics: l.topics, data: l.data}))};
        },
        async redeemed(fromBlock, toBlock) {
            const logs = await client.getLogs({address: contracts.delegationManager, event: REDEEMED_DELEGATION_EVENT, fromBlock, toBlock});
            return logs.map(log => ({
                ...position(log),
                rootDelegator: getAddress(present(log.args.rootDelegator, "rootDelegator")),
                redeemer: getAddress(present(log.args.redeemer, "redeemer")),
                authority: present(log.args.delegation, "delegation").authority,
            }));
        },
        async disabled(fromBlock, toBlock) {
            const logs = await client.getLogs({address: contracts.delegationManager, event: DISABLED_DELEGATION_EVENT, fromBlock, toBlock});
            return logs.map(log => ({...position(log), delegator: getAddress(present(log.args.delegator, "delegator"))}));
        },
        async deployed(fromBlock, toBlock) {
            const logs = await client.getLogs({address: contracts.simpleFactory, event: SIMPLE_FACTORY_DEPLOYED_EVENT, fromBlock, toBlock});
            return logs.map(log => ({...position(log), account: getAddress(present(log.args.addr, "addr"))}));
        },
    };
}
