/** A confirmed bootstrap can reach one RPC replica before another. Never re-sign or re-bootstrap here. */
export async function readFundedBalance(
    read: () => Promise<bigint | undefined>, needed: bigint,
    wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 1500)),
): Promise<bigint | undefined> {
    let balance: bigint | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt) await wait();
        balance = await read();
        if (balance !== undefined && balance >= needed) return balance;
    }
    return balance;
}
