import {afterEach, describe, expect, test} from "bun:test";
import {
    FAUCET_ETH_AMOUNT_WEI,
    FAUCET_ETH_WINDOW_MS,
    FAUCET_LIMITS,
    FAUCET_TARGET_BASE,
    FAUCET_WINDOW_MS,
} from "@mapae/delegation/faucet-policy";
import {MOCK_USDC} from "@mapae/shared";
import {openFaucetStore, type FaucetStore} from "@mapae/store/faucet";
import {decodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex} from "viem";
import {
    MAX_FEE_PER_GAS,
    MINT_GAS,
    REBROADCAST_AFTER_MS,
    STALE_RESERVATION_MS,
    TRANSFER_GAS,
    bearerMatches,
    createFaucet,
    parseClaimRequest,
    type BroadcastResult,
    type ClaimRequest,
    type FaucetChain,
    type FaucetConfig,
    type FaucetTransaction,
    type ReceiptStatus,
} from "./claims";

const T0 = 1_760_000_000_000;
const FAUCET = getAddress(`0x${"fa".repeat(20)}`);
const MINT_ABI = parseAbi(["function mint(address to, uint256 value)"]);
const ETHER = 10n ** 18n;
const owner = (n: number) => getAddress(`0x${(0x1000 + n).toString(16).padStart(40, "0")}`);
const payerOf = (address: Address) => getAddress(`0x${address.slice(-38)}bb`);
const key = (n: number) => n.toString(16).padStart(64, "0");

/**
 * A chain that keeps balances, nonces and a mempool in memory. Broadcasts apply on
 * `mine()`, so a test decides when a transaction lands — or that it never does.
 */
class FakeChain implements FaucetChain {
    eth = new Map<string, bigint>([[FAUCET.toLowerCase(), ETHER]]);
    token = new Map<string, bigint>();
    codes = new Map<string, Hex>();
    mainnet = new Map<string, number>();
    mempool = new Map<Hex, FaucetTransaction>();
    receipts = new Map<Hex, ReceiptStatus>();
    mined = 0;
    fee: bigint | null = 1_000_000n;
    sends: Hex[] = [];
    sendMode: "accept" | "reject" | "throw" = "accept";
    receiptMode: "instant" | "timeout" = "instant";
    revert = false;
    failMainnet = false;
    failToken = false;
    signed = new Map<Hex, FaucetTransaction>();

    balance = async (address: Address) => this.eth.get(address.toLowerCase()) ?? 0n;
    tokenBalance = async (address: Address) => {
        if (this.failToken) throw new Error("token read failed");
        return this.token.get(address.toLowerCase()) ?? 0n;
    };
    code = async (address: Address) => this.codes.get(address.toLowerCase());
    baseFee = async () => this.fee;
    nonce = async (_address: Address, tag: "pending" | "latest") => (tag === "latest" ? this.mined : this.mined + this.mempool.size);
    sendRaw = async (raw: Hex): Promise<BroadcastResult> => {
        this.sends.push(raw);
        if (this.sendMode === "throw") throw new Error("socket hang up");
        if (this.sendMode === "reject") return "rejected";
        const tx = this.signed.get(raw)!;
        if (tx.nonce < this.mined) return "rejected";
        this.mempool.set(keccak256(raw), tx);
        if (this.receiptMode === "instant") this.mine();
        return "accepted";
    };
    receipt = async (hash: Hex) => this.receipts.get(hash) ?? null;
    waitForReceipt = async (hash: Hex) => (this.receiptMode === "timeout" ? null : (this.receipts.get(hash) ?? null));
    mainnetNonce = async (address: Address) => {
        if (this.failMainnet) throw new Error("mainnet read failed");
        return this.mainnet.get(address.toLowerCase()) ?? 0;
    };
    payer = async (address: Address) => payerOf(address);

    /** Mine every pending transaction in nonce order, as long as the nonces are contiguous. */
    mine() {
        for (;;) {
            const next = [...this.mempool].find(([, tx]) => tx.nonce === this.mined);
            if (!next) return;
            const [hash, tx] = next;
            this.mempool.delete(hash);
            this.mined += 1;
            this.receipts.set(hash, this.revert ? "reverted" : "success");
            if (this.revert) continue;
            if (tx.data) {
                const {args} = decodeFunctionData({abi: MINT_ABI, data: tx.data});
                const [to, value] = args as [Address, bigint];
                this.token.set(to.toLowerCase(), (this.token.get(to.toLowerCase()) ?? 0n) + value);
            } else {
                this.eth.set(tx.to.toLowerCase(), (this.eth.get(tx.to.toLowerCase()) ?? 0n) + tx.value);
                this.eth.set(FAUCET.toLowerCase(), (this.eth.get(FAUCET.toLowerCase()) ?? 0n) - tx.value);
            }
        }
    }
}

const stores: FaucetStore[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) store.close();
});

function setup(overrides: Partial<FaucetConfig> = {}) {
    const chain = new FakeChain();
    const store = openFaucetStore(":memory:");
    stores.push(store);
    let clock = T0;
    const signs: FaucetTransaction[] = [];
    const faucet = createFaucet({
        store,
        chain,
        signer: {
            address: FAUCET,
            async sign(tx) {
                signs.push(tx);
                const raw = toHex(JSON.stringify({...tx, value: String(tx.value), gas: String(tx.gas), maxFeePerGas: "", maxPriorityFeePerGas: ""}));
                chain.signed.set(raw, tx);
                return raw;
            },
        },
        config: {enabled: true, ethMissions: ["x_follow_mapae"], ethDailyWei: 10n * FAUCET_ETH_AMOUNT_WEI, minBalanceWei: 2n * 10n ** 16n, ...overrides},
        now: () => clock,
    });
    return {chain, store, faucet, signs, tick: (ms: number) => (clock += ms), at: () => clock};
}

function request(overrides: Partial<ClaimRequest> = {}): ClaimRequest {
    return {kind: "musdc", owner: owner(1), ipKey: key(1), subnetKey: key(1001), missions: ["x_follow_mapae"], ...overrides};
}
const ethRequest = (n: number, overrides: Partial<ClaimRequest> = {}) =>
    request({kind: "eth", owner: owner(n), ipKey: key(n), subnetKey: key(1000 + n), ...overrides});

describe("stablecoin top-up", () => {
    test("mints the shortfall to the owner's payer account and confirms it", async () => {
        const {chain, faucet, signs} = setup();
        chain.token.set(payerOf(owner(1)).toLowerCase(), 250_000_000n);
        const outcome = await faucet.claim(request());
        expect(outcome).toMatchObject({ok: true, view: {kind: "musdc", state: "confirmed", amount: "750000000", recipient: payerOf(owner(1)), nextAt: T0 + FAUCET_WINDOW_MS}});
        expect(chain.token.get(payerOf(owner(1)).toLowerCase())).toBe(FAUCET_TARGET_BASE);
        expect(signs[0]).toMatchObject({to: MOCK_USDC.address, value: 0n, gas: MINT_GAS, nonce: 0, maxFeePerGas: MAX_FEE_PER_GAS});
    });

    test("a payer already at the target is skipped, sends nothing and keeps no window", async () => {
        const {chain, faucet, signs, tick} = setup();
        chain.token.set(payerOf(owner(1)).toLowerCase(), FAUCET_TARGET_BASE);
        expect(await faucet.claim(request())).toMatchObject({ok: true, view: {state: "already_enough", amount: "0"}});
        expect(signs).toHaveLength(0);
        chain.token.set(payerOf(owner(1)).toLowerCase(), 0n);
        tick(1_000);
        expect(await faucet.claim(request())).toMatchObject({ok: true, view: {state: "confirmed"}});
    });

    test("a second claim inside the day is a cooldown with the time the window opens", async () => {
        const {faucet, tick} = setup();
        await faucet.claim(request());
        tick(3_600_000);
        expect(await faucet.claim(request())).toEqual({ok: false, refusal: "cooldown", status: 429, nextAt: T0 + FAUCET_WINDOW_MS});
    });

    test("the follow mission must be asserted", async () => {
        const {faucet, signs} = setup();
        expect(await faucet.claim(request({missions: []}))).toEqual({ok: false, refusal: "mission_incomplete", status: 403});
        expect(await faucet.claim(request({missions: ["something_else"]}))).toMatchObject({refusal: "mission_incomplete"});
        expect(signs).toHaveLength(0);
    });

    test("one address bucket gets five a day; the sixth wallet behind it is rate_limited", async () => {
        const {faucet} = setup();
        for (let n = 1; n <= FAUCET_LIMITS.musdc.perIp; n += 1) {
            expect(await faucet.claim(request({owner: owner(n)}))).toMatchObject({ok: true});
        }
        expect(await faucet.claim(request({owner: owner(99)}))).toEqual({ok: false, refusal: "rate_limited", status: 429});
    });

    test("a token balance that cannot be read fails the claim without a window", async () => {
        const {chain, faucet, store} = setup();
        chain.failToken = true;
        expect(await faucet.claim(request())).toEqual({ok: false, refusal: "unavailable", status: 503});
        expect(store.latest("musdc", owner(1).toLowerCase())?.state).toBe("failed");
        chain.failToken = false;
        expect(await faucet.claim(request())).toMatchObject({ok: true, view: {state: "confirmed"}});
    });

    test("an off switch answers faucet_off for both tabs", async () => {
        const {faucet} = setup({enabled: false});
        expect(await faucet.claim(request())).toMatchObject({refusal: "faucet_off", status: 503});
        expect(await faucet.claim(ethRequest(1))).toMatchObject({refusal: "faucet_off"});
        const status = await faucet.status();
        expect(status.musdc.enabled).toBe(false);
        expect(status.eth.enabled).toBe(false);
    });
});

describe("ETH claims", () => {
    function eligible(chain: FakeChain, n: number) {
        chain.mainnet.set(owner(n).toLowerCase(), 3);
    }

    test("sends 0.05 ETH to the wallet itself once the missions are done", async () => {
        const {chain, faucet, signs} = setup();
        eligible(chain, 1);
        expect(await faucet.claim(ethRequest(1))).toMatchObject({
            ok: true,
            view: {kind: "eth", state: "confirmed", amount: String(FAUCET_ETH_AMOUNT_WEI), recipient: owner(1), nextAt: T0 + FAUCET_ETH_WINDOW_MS},
        });
        expect(chain.eth.get(owner(1).toLowerCase())).toBe(FAUCET_ETH_AMOUNT_WEI);
        expect(signs[0]).toMatchObject({to: owner(1), value: FAUCET_ETH_AMOUNT_WEI, gas: TRANSFER_GAS});
    });

    test("with no missions configured the ETH tab is off, whatever the caller asserts", async () => {
        const {chain, faucet} = setup({ethMissions: []});
        eligible(chain, 1);
        expect(await faucet.claim(ethRequest(1))).toMatchObject({refusal: "faucet_off"});
        expect((await faucet.status()).eth).toMatchObject({enabled: false, missions: []});
        expect((await faucet.status()).musdc.enabled).toBe(true);
    });

    test("a wallet with no main-chain history is not eligible; a failed read never passes", async () => {
        const {chain, faucet, signs} = setup();
        expect(await faucet.claim(ethRequest(1))).toEqual({ok: false, refusal: "not_eligible", status: 403});
        chain.failMainnet = true;
        eligible(chain, 1);
        expect(await faucet.claim(ethRequest(1))).toEqual({ok: false, refusal: "eligibility_unavailable", status: 503});
        expect(signs).toHaveLength(0);
    });

    test("a contract at the address is refused; an EIP-7702 delegated wallet is not", async () => {
        const {chain, faucet} = setup();
        eligible(chain, 1);
        eligible(chain, 2);
        chain.codes.set(owner(1).toLowerCase(), "0x6080604052");
        chain.codes.set(owner(2).toLowerCase(), `0xef0100${"12".repeat(20)}`);
        expect(await faucet.claim(ethRequest(1))).toMatchObject({refusal: "not_eligible"});
        expect(await faucet.claim(ethRequest(2))).toMatchObject({ok: true, view: {state: "confirmed"}});
    });

    test("a wallet that already holds 0.05 ETH is skipped", async () => {
        const {chain, faucet, signs} = setup();
        eligible(chain, 1);
        chain.eth.set(owner(1).toLowerCase(), FAUCET_ETH_AMOUNT_WEI);
        expect(await faucet.claim(ethRequest(1))).toMatchObject({ok: true, view: {state: "already_enough", amount: "0"}});
        expect(signs).toHaveLength(0);
    });

    test("a week-long window per wallet", async () => {
        const {chain, faucet, tick} = setup();
        eligible(chain, 1);
        await faucet.claim(ethRequest(1));
        chain.eth.set(owner(1).toLowerCase(), 0n);
        tick(FAUCET_ETH_WINDOW_MS - 1);
        expect(await faucet.claim(ethRequest(1, {ipKey: key(50), subnetKey: key(51)}))).toMatchObject({refusal: "cooldown", nextAt: T0 + FAUCET_ETH_WINDOW_MS});
        tick(1);
        expect(await faucet.claim(ethRequest(1, {ipKey: key(50), subnetKey: key(51)}))).toMatchObject({ok: true});
    });

    test("one claim per address bucket and three per subnet a day stop a single-machine farm", async () => {
        const {chain, faucet} = setup();
        for (let n = 1; n <= 9; n += 1) eligible(chain, n);
        expect(await faucet.claim(ethRequest(1))).toMatchObject({ok: true});
        expect(await faucet.claim(ethRequest(2, {ipKey: key(1)}))).toMatchObject({refusal: "rate_limited"});
        // Rotating addresses inside one /24: two more, then the subnet is full.
        const subnet = key(1001);
        expect(await faucet.claim(ethRequest(3, {subnetKey: subnet}))).toMatchObject({ok: true});
        expect(await faucet.claim(ethRequest(4, {subnetKey: subnet}))).toMatchObject({ok: true});
        expect(await faucet.claim(ethRequest(5, {subnetKey: subnet}))).toMatchObject({refusal: "rate_limited"});
    });

    test("the daily wei cap is a hard bound across every network", async () => {
        const {chain, faucet} = setup({ethDailyWei: 2n * FAUCET_ETH_AMOUNT_WEI});
        for (let n = 1; n <= 3; n += 1) eligible(chain, n);
        expect(await faucet.claim(ethRequest(1))).toMatchObject({ok: true});
        expect(await faucet.claim(ethRequest(2))).toMatchObject({ok: true});
        expect(await faucet.claim(ethRequest(3))).toEqual({ok: false, refusal: "budget_exhausted", status: 503});
    });

    test("the ETH tab never spends the floor kept for mint gas; the stablecoin still can", async () => {
        const {chain, faucet} = setup();
        eligible(chain, 1);
        chain.eth.set(FAUCET.toLowerCase(), 2n * 10n ** 16n + FAUCET_ETH_AMOUNT_WEI);
        expect(await faucet.claim(ethRequest(1))).toEqual({ok: false, refusal: "faucet_empty", status: 503});
        expect(await faucet.claim(request())).toMatchObject({ok: true, view: {state: "confirmed"}});
        const status = await faucet.status();
        expect(status.eth.enabled).toBe(false);
        expect(status.musdc.enabled).toBe(true);
    });

    test("an empty-handed refusal leaves no window, so the wallet can claim once refilled", async () => {
        const {chain, faucet, tick} = setup();
        eligible(chain, 1);
        chain.eth.set(FAUCET.toLowerCase(), 0n);
        expect(await faucet.claim(ethRequest(1))).toMatchObject({refusal: "faucet_empty"});
        chain.eth.set(FAUCET.toLowerCase(), ETHER);
        tick(20_000);
        expect(await faucet.claim(ethRequest(1))).toMatchObject({ok: true});
    });

    test("a base fee above the cap, or unreadable, refuses before signing", async () => {
        const {chain, faucet, signs} = setup();
        chain.fee = MAX_FEE_PER_GAS + 1n;
        expect(await faucet.claim(request())).toMatchObject({refusal: "fee_too_high"});
        chain.fee = null;
        expect(await faucet.claim(request())).toMatchObject({refusal: "unavailable"});
        expect(signs).toHaveLength(0);
    });
});

describe("missions", () => {
    test("a verified mission asks its verifier; a missing verifier refuses boot", async () => {
        const {FAUCET_MISSIONS} = await import("@mapae/delegation/faucet-policy");
        const mission = FAUCET_MISSIONS.x_follow_mapae as {kind: "honour" | "verified"};
        mission.kind = "verified";
        try {
            expect(() => setup()).toThrow(/no verifier/);
            const followers = new Set([owner(1).toLowerCase()]);
            const {faucet} = setup({verifiers: {x_follow_mapae: async (who) => followers.has(who.toLowerCase())}});
            expect(await faucet.claim(request())).toMatchObject({ok: true});
            expect(await faucet.claim(request({owner: owner(2)}))).toMatchObject({refusal: "mission_incomplete"});
            const broken = setup({verifiers: {x_follow_mapae: async () => {throw new Error("api down");}}});
            expect(await broken.faucet.claim(request({owner: owner(3)}))).toMatchObject({refusal: "eligibility_unavailable"});
        } finally {
            mission.kind = "honour";
        }
    });
});

describe("broadcast and recovery", () => {
    test("concurrent claims get consecutive nonces, never the same one", async () => {
        const {chain, faucet, signs} = setup();
        chain.receiptMode = "timeout";
        const outcomes = await Promise.all([1, 2, 3, 4].map((n) => faucet.claim(request({owner: owner(n), ipKey: key(n)}))));
        expect(outcomes.every((o) => o.ok && o.view.state === "pending")).toBe(true);
        expect(signs.map((s) => s.nonce).sort()).toEqual([0, 1, 2, 3]);
    });

    test("a retry while a claim is in flight returns that claim and signs nothing new", async () => {
        const {chain, faucet, signs} = setup();
        chain.receiptMode = "timeout";
        const first = await faucet.claim(request());
        const again = await faucet.claim(request({ipKey: key(77)}));
        expect(again).toEqual(first);
        expect(signs).toHaveLength(1);
    });

    test("a receipt timeout answers pending; the reconciler confirms it once mined", async () => {
        const {chain, faucet, store, tick} = setup();
        chain.receiptMode = "timeout";
        const outcome = await faucet.claim(request());
        expect(outcome).toMatchObject({ok: true, view: {state: "pending"}});
        chain.mine();
        tick(15_000);
        await faucet.reconcile();
        expect(store.latest("musdc", owner(1).toLowerCase())?.state).toBe("confirmed");
        expect((await faucet.account(owner(1))).musdc).toMatchObject({state: "confirmed", transaction: expect.any(String)});
    });

    test("a reverted transaction fails the claim but keeps its hash", async () => {
        const {chain, faucet} = setup();
        chain.revert = true;
        expect(await faucet.claim(request())).toMatchObject({ok: true, view: {state: "failed", transaction: expect.any(String)}});
    });

    test("a node that rejects the broadcast fails the claim and frees its nonce", async () => {
        const {chain, faucet, signs, tick} = setup();
        chain.sendMode = "reject";
        expect(await faucet.claim(request())).toMatchObject({refusal: "unavailable"});
        chain.sendMode = "accept";
        tick(1_000);
        expect(await faucet.claim(request())).toMatchObject({ok: true, view: {state: "confirmed"}});
        expect(signs.map((s) => s.nonce)).toEqual([0, 0]);
    });

    test("an ambiguous broadcast stays signed; the reconciler resends the same bytes after two minutes", async () => {
        const {chain, faucet, store, tick} = setup();
        chain.sendMode = "throw";
        expect(await faucet.claim(request())).toMatchObject({ok: true, view: {state: "pending"}});
        const row = store.latest("musdc", owner(1).toLowerCase())!;
        expect(row.state).toBe("signed");

        chain.sendMode = "accept";
        tick(REBROADCAST_AFTER_MS - 1);
        await faucet.reconcile();
        expect(chain.sends).toHaveLength(1);
        tick(1);
        await faucet.reconcile();
        expect(chain.sends).toEqual([row.raw_tx as Hex, row.raw_tx as Hex]);
        await faucet.reconcile();
        expect(store.get(row.id)?.state).toBe("confirmed");
    });

    test("a signed claim whose nonce another transaction took is failed, not resent", async () => {
        const {chain, faucet, store, tick} = setup();
        chain.sendMode = "throw";
        await faucet.claim(request());
        const row = store.latest("musdc", owner(1).toLowerCase())!;
        chain.mined = 1;
        tick(REBROADCAST_AFTER_MS);
        await faucet.reconcile();
        expect(store.get(row.id)?.state).toBe("failed");
        expect(chain.sends).toHaveLength(1);
    });

    test("a claim that died before signing is failed after two minutes and is never broadcast", async () => {
        const {faucet, store, tick} = setup();
        const claim = store.reserve(
            {kind: "musdc", owner: owner(1).toLowerCase(), recipient: payerOf(owner(1)).toLowerCase(), ipKey: key(1), subnetKey: key(2), amount: 0n},
            T0,
            {windowMs: FAUCET_WINDOW_MS, dayMs: FAUCET_WINDOW_MS, perIp: 5, perSubnet: 20},
        );
        if (!claim.ok) throw new Error("expected a reservation");
        tick(STALE_RESERVATION_MS);
        await faucet.reconcile();
        expect(store.get(claim.claim.id)?.state).toBe("reserved");
        tick(1);
        await faucet.reconcile();
        expect(store.get(claim.claim.id)?.state).toBe("failed");
        expect(await faucet.claim(request())).toMatchObject({ok: true});
    });

    test("a signed transaction the node has not seen holds its nonce for the next claim", async () => {
        const {chain, faucet, signs} = setup();
        chain.sendMode = "throw";
        await faucet.claim(request());
        chain.sendMode = "accept";
        chain.receiptMode = "timeout";
        await faucet.claim(request({owner: owner(2), ipKey: key(2)}));
        // The node's pending count is still 0, but the ledger knows nonce 0 is spoken for.
        expect(signs.map((s) => s.nonce)).toEqual([0, 1]);
    });
});

describe("status and account", () => {
    test("status reports the configuration, never a balance", async () => {
        const {faucet} = setup();
        const status = await faucet.status();
        expect(status).toEqual({
            musdc: {enabled: true, targetBase: String(FAUCET_TARGET_BASE), windowMs: FAUCET_WINDOW_MS, missions: ["x_follow_mapae"]},
            eth: {enabled: true, amountWei: String(FAUCET_ETH_AMOUNT_WEI), windowMs: FAUCET_ETH_WINDOW_MS, missions: ["x_follow_mapae"], minMainnetNonce: 1},
        });
        expect(JSON.stringify(status)).not.toContain(String(ETHER));
    });

    test("account names both recipients and the latest claim of each kind", async () => {
        const {faucet} = setup();
        expect(await faucet.account(owner(1))).toEqual({owner: owner(1), recipients: {musdc: payerOf(owner(1)), eth: owner(1)}, musdc: null, eth: null});
        await faucet.claim(request());
        expect((await faucet.account(owner(1))).musdc).toMatchObject({state: "confirmed", nextAt: T0 + FAUCET_WINDOW_MS});
    });

    test("an elapsed window drops nextAt from the view", async () => {
        const {faucet, tick} = setup();
        await faucet.claim(request());
        tick(FAUCET_WINDOW_MS);
        expect((await faucet.account(owner(1))).musdc).not.toHaveProperty("nextAt");
    });
});

describe("request boundary", () => {
    test("parseClaimRequest keeps only a well-formed claim", () => {
        const body = {kind: "eth", owner: owner(1).toLowerCase(), ipKey: key(1), subnetKey: key(2), missions: ["x_follow_mapae"], extra: true};
        expect(parseClaimRequest(body)).toEqual({kind: "eth", owner: owner(1), ipKey: key(1), subnetKey: key(2), missions: ["x_follow_mapae"]});
        for (const bad of [
            {...body, kind: "btc"},
            {...body, owner: "0x1234"},
            {...body, ipKey: "203.0.113.7"},
            {...body, subnetKey: key(2).toUpperCase().replace(/^0+/, "A")},
            {...body, missions: "x_follow_mapae"},
            {...body, missions: Array.from({length: 17}, () => "x")},
            {...body, missions: ["DROP TABLE"]},
            null,
            [],
        ]) {
            expect(parseClaimRequest(bad)).toBeUndefined();
        }
    });

    test("bearerMatches accepts exactly the token", async () => {
        const token = "t".repeat(40);
        expect(await bearerMatches(`Bearer ${token}`, token)).toBe(true);
        expect(await bearerMatches(`Bearer ${token}x`, token)).toBe(false);
        expect(await bearerMatches(`Bearer ${token.slice(1)}`, token)).toBe(false);
        expect(await bearerMatches(token, token)).toBe(false);
        expect(await bearerMatches(undefined, token)).toBe(false);
    });
});
