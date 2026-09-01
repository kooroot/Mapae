/** The shop's store, shared by the server and the seed: one file, read by both. */
export function readStorePath(): string {
    return process.env.STORE_PATH?.trim() || "./data/seller.sqlite";
}
