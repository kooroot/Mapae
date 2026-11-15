import {expect, test} from "bun:test";
import {buildClassifier} from "./addresses";
import {computeChainMetrics, computeRetention, kstDay, kstDayStart, percentile, type ChainEvents, type SettlementRow} from "./metrics";

const SIGNER = "0x5ea109edc7e89b6a752032aa2b6f1092e081e7ec";
const SPONSOR = "0x11e188f700000000000000000000000000003211";
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const INTERNAL_PAYER = a(1), COHORT_PAYER = a(2), ORGANIC_PAYER = a(3), ORGANIC_2 = a(4);
const SHOP = a(100), EXTERNAL_SHOP = a(101);
const classifier = buildClassifier([INTERNAL_PAYER, SHOP], [COHORT_PAYER]);
const roles = {signer: SIGNER, sponsor: SPONSOR};
const kst = (iso: string) => Date.parse(`${iso}+09:00`);
const DAY = "2026-10-12";
const window = {startMs: kstDayStart(DAY), endMs: kstDayStart(DAY) + 86_400_000};
const pay = (payer: string, payTo: string | null, at: string, txFrom = SIGNER): SettlementRow => ({payer, payTo, txFrom, at: kst(at)});
const events = (settlements: SettlementRow[], rest: Partial<ChainEvents> = {}): ChainEvents => ({settlements, foreignRedemptions: [], revocations: [], deployments: [], ...rest});

test("KST day boundaries are nine hours ahead of UTC", () => {
    expect(kstDay(Date.parse("2026-10-11T15:00:00Z"))).toBe("2026-10-12");
    expect(kstDay(Date.parse("2026-10-11T14:59:59Z"))).toBe("2026-10-11");
    expect(kstDayStart("2026-10-12")).toBe(Date.parse("2026-10-11T15:00:00Z"));
});

test("each settlement lands in its payer's column", () => {
    const m = computeChainMetrics(events([
        pay(INTERNAL_PAYER, SHOP, "2026-10-12T10:00:00"),
        pay(COHORT_PAYER, SHOP, "2026-10-12T11:00:00"),
        pay(COHORT_PAYER, EXTERNAL_SHOP, "2026-10-12T12:00:00"),
        pay(ORGANIC_PAYER, EXTERNAL_SHOP, "2026-10-12T13:00:00"),
        pay(ORGANIC_2, EXTERNAL_SHOP, "2026-10-13T00:00:00"), // the next KST day: outside
    ]), window, classifier, roles);
    expect(m.settlements).toEqual({internal: 1, cohort: 2, organic: 1});
    expect(m.payingWallets).toEqual({internal: 1, cohort: 1, organic: 1});
    expect(m.externalPayees).toEqual({internal: 0, cohort: 1, organic: 1});
    expect(m.payerPayeePairs).toEqual({internal: 1, cohort: 2, organic: 1});
    expect(m.payeeTop1).toEqual({part: {internal: 1, cohort: 1, organic: 1}, whole: {internal: 1, cohort: 2, organic: 1}});
});

test("a repeat payer needs two distinct KST days, not two UTC days", () => {
    const m = computeChainMetrics(events([
        // 08:30 and 09:30 KST straddle UTC midnight but are one Korean morning.
        pay(ORGANIC_PAYER, EXTERNAL_SHOP, "2026-10-12T08:30:00"),
        pay(ORGANIC_PAYER, EXTERNAL_SHOP, "2026-10-12T09:30:00"),
        // 23:50 the day before and 00:10 today are the same UTC day but two KST days.
        pay(ORGANIC_2, EXTERNAL_SHOP, "2026-10-11T23:50:00"),
        pay(ORGANIC_2, EXTERNAL_SHOP, "2026-10-12T00:10:00"),
    ]), window, classifier, roles);
    expect(m.repeatPayingWallets.organic).toBe(1);
    expect(m.newPayingWallets.organic).toBe(1); // ORGANIC_2 first paid yesterday
    expect(m.payingWallets.organic).toBe(2);
});

test("history after the window never makes a payer repeat or old", () => {
    const m = computeChainMetrics(events([
        pay(ORGANIC_PAYER, EXTERNAL_SHOP, "2026-10-12T12:00:00"),
        pay(ORGANIC_PAYER, EXTERNAL_SHOP, "2026-10-14T12:00:00"),
    ]), window, classifier, roles);
    expect(m.repeatPayingWallets.organic).toBe(0);
    expect(m.newPayingWallets.organic).toBe(1);
});

test("self-payments are counted apart and excluded from everything else", () => {
    const m = computeChainMetrics(events([
        pay(ORGANIC_PAYER, ORGANIC_PAYER, "2026-10-11T12:00:00"),
        pay(ORGANIC_PAYER, ORGANIC_PAYER, "2026-10-12T12:00:00"),
    ]), window, classifier, roles);
    expect(m.selfPayments).toEqual({internal: 0, cohort: 0, organic: 1});
    expect(m.settlements.organic).toBe(0);
    expect(m.payingWallets.organic).toBe(0);
    expect(m.repeatPayingWallets.organic).toBe(0);
    expect(m.externalPayees.organic).toBe(0);
    expect(m.payeeTop1.whole.organic).toBe(0);
});

test("onboarding counts only sponsor-sent deployments; revocations and gas violations by column", () => {
    const at = kst("2026-10-12T12:00:00");
    const m = computeChainMetrics(events([pay(COHORT_PAYER, SHOP, "2026-10-12T12:00:00", a(999)), pay(ORGANIC_PAYER, null, "2026-10-12T12:00:00")], {
        deployments: [{account: ORGANIC_PAYER, txFrom: SPONSOR, at}, {account: ORGANIC_2, txFrom: a(5), at}],
        revocations: [{delegator: COHORT_PAYER, at}, {delegator: COHORT_PAYER, at: at - 86_400_000}],
    }), window, classifier, roles);
    expect(m.onboardedAccounts).toEqual({internal: 0, cohort: 0, organic: 1});
    expect(m.revocations).toEqual({internal: 0, cohort: 1, organic: 0});
    expect(m.payerGasViolations).toEqual({internal: 0, cohort: 1, organic: 0});
    // A settlement with no attributable transfer still counts as a settlement, never as a payee.
    expect(m.settlements.organic).toBe(1);
    expect(m.payeeTop1.whole.organic).toBe(0);
    expect(computeChainMetrics(events([], {deployments: [{account: ORGANIC_PAYER, txFrom: SPONSOR, at}]}), window, classifier, {signer: SIGNER}).onboardedAccounts.organic).toBe(0);
});

test("a Mapae payer's payment the signer did not send is a gas violation, and never a settlement", () => {
    const OTHER = a(777);
    const STRANGER = a(6);
    const settled = [
        pay(COHORT_PAYER, SHOP, "2026-10-10T12:00:00"),
        pay(ORGANIC_PAYER, EXTERNAL_SHOP, "2026-10-12T09:00:00"),
        pay(INTERNAL_PAYER, SHOP, "2026-10-13T09:00:00"), // settled for only after the window
    ];
    const foreignRedemptions = [
        pay(COHORT_PAYER, EXTERNAL_SHOP, "2026-10-12T10:00:00", OTHER), // known by an earlier settlement
        pay(ORGANIC_PAYER, EXTERNAL_SHOP, "2026-10-12T08:00:00", ORGANIC_PAYER), // known by a settlement later the same day
        pay(ORGANIC_2, EXTERNAL_SHOP, "2026-10-12T11:00:00", OTHER), // known only as a sponsor deployment
        pay(STRANGER, EXTERNAL_SHOP, "2026-10-12T11:00:00", OTHER), // somebody else's use of the same DelegationManager
        pay(INTERNAL_PAYER, SHOP, "2026-10-12T11:00:00", OTHER), // not yet a Mapae payer at the window's end
        pay(COHORT_PAYER, EXTERNAL_SHOP, "2026-10-11T10:00:00", OTHER), // the day before: outside
        pay(COHORT_PAYER, COHORT_PAYER, "2026-10-12T10:00:00", OTHER), // self-payment
        pay(COHORT_PAYER, EXTERNAL_SHOP, "2026-10-12T10:30:00", SIGNER), // our signer sent it through another redeemer: gas was ours
    ];
    const deployments = [{account: ORGANIC_2, txFrom: SPONSOR, at: kst("2026-10-01T12:00:00")}, {account: STRANGER, txFrom: a(5), at: kst("2026-10-01T12:00:00")}];
    const withForeign = computeChainMetrics(events(settled, {foreignRedemptions, deployments}), window, classifier, roles);
    expect(withForeign.payerGasViolations).toEqual({internal: 0, cohort: 1, organic: 2});

    // Every other figure is what it is without the foreign redemptions.
    const without = computeChainMetrics(events(settled, {deployments}), window, classifier, roles);
    expect(without.payerGasViolations).toEqual({internal: 0, cohort: 0, organic: 0});
    expect({...withForeign, payerGasViolations: without.payerGasViolations}).toEqual(without);
    expect(withForeign.settlements).toEqual({internal: 0, cohort: 0, organic: 1});
    expect(computeRetention(events(settled, {foreignRedemptions}), window.endMs, classifier)).toEqual(computeRetention(events(settled), window.endMs, classifier));

    // Without a configured sponsor, a deployment makes nobody a Mapae payer.
    expect(computeChainMetrics(events(settled, {foreignRedemptions, deployments}), window, classifier, {signer: SIGNER}).payerGasViolations.organic).toBe(1);
});

test("internal wins when an address is listed in both sets", () => {
    const both = buildClassifier([COHORT_PAYER], [COHORT_PAYER]);
    expect(computeChainMetrics(events([pay(COHORT_PAYER, SHOP, "2026-10-12T12:00:00")]), window, both, roles).settlements).toEqual({internal: 1, cohort: 0, organic: 0});
});

test("W1/W4 retention counts only payers whose week has fully elapsed, from their first KST day", () => {
    const end = kstDayStart("2026-10-12") + 86_400_000;
    const r = computeRetention(events([
        // First paid 09-21 at 23:50: W1 is 09-28..10-04 by KST day, and 10-01 lands in it.
        pay(ORGANIC_PAYER, EXTERNAL_SHOP, "2026-09-21T23:50:00"),
        pay(ORGANIC_PAYER, EXTERNAL_SHOP, "2026-10-01T12:00:00"),
        // First paid 09-21, back only on 09-25 (week 0) and 10-19 (after the end): not retained.
        pay(ORGANIC_2, EXTERNAL_SHOP, "2026-09-21T10:00:00"),
        pay(ORGANIC_2, EXTERNAL_SHOP, "2026-09-25T10:00:00"),
        pay(ORGANIC_2, EXTERNAL_SHOP, "2026-10-19T10:00:00"),
        // First paid 09-30: W1 is 10-07..10-13, not over by 10-12, so not yet in the denominator.
        pay(COHORT_PAYER, SHOP, "2026-09-30T10:00:00"),
        // A payer who only ever paid themself has no first settlement.
        pay(a(5), a(5), "2026-09-01T10:00:00"),
        // First paid 09-08; W4 is 10-06..10-12, the last day of which is still inside.
        pay(INTERNAL_PAYER, SHOP, "2026-09-08T10:00:00"),
        pay(INTERNAL_PAYER, SHOP, "2026-10-12T23:59:00"),
    ]), end, classifier);
    expect(r.w1).toEqual({part: {internal: 0, cohort: 0, organic: 1}, whole: {internal: 1, cohort: 0, organic: 2}});
    expect(r.w4).toEqual({part: {internal: 1, cohort: 0, organic: 0}, whole: {internal: 1, cohort: 0, organic: 0}});
});

test("nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile(Array.from({length: 100}, (_, i) => i + 1), 95)).toBe(95);
});
