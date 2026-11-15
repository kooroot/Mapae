import {describe, expect, test} from "bun:test";
import {countDailyActivatedPayers, DAP_DEFAULTS, koreanDay, type OwnerFunding, type SettledPayment} from "./dap.js";

const CHAIN = "eip155:91342";
const at = (iso: string) => Date.parse(iso) / 1000;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const pay = (owner: string, iso: string, kind: SettledPayment["kind"] = "arcade", chainId = CHAIN): SettledPayment => ({
    owner,
    settledAt: at(iso),
    chainId,
    kind,
});
const fund = (owner: string, firstFunder: string, iso: string): OwnerFunding => ({owner, firstFunder, firstTxAt: at(iso)});

describe("countDailyActivatedPayers", () => {
    test("defaults are 3 shared-funder others and 5 same-day owners on GIWA Sepolia", () => {
        expect(DAP_DEFAULTS).toEqual({sharedFunderMinOthers: 3, sameDayClusterMin: 5, chainId: CHAIN});
    });

    test("the Korean day turns at 15:00 UTC", () => {
        expect(koreanDay(at("2026-11-02T14:59:59Z"))).toBe("2026-11-02");
        expect(koreanDay(at("2026-11-02T15:00:00Z"))).toBe("2026-11-03");
        const days = countDailyActivatedPayers([pay(addr(1), "2026-11-02T14:59:59Z"), pay(addr(2), "2026-11-02T15:00:00Z")], []);
        expect(days.map((d) => [d.day, d.dap])).toEqual([
            ["2026-11-02", 1],
            ["2026-11-03", 1],
        ]);
    });

    test("an owner paying twice in one day counts once, regardless of address case", () => {
        const owner = "0xAbCdEf0000000000000000000000000000000001";
        const [day] = countDailyActivatedPayers(
            [pay(owner, "2026-11-02T01:00:00Z"), pay(owner.toLowerCase(), "2026-11-02T09:00:00Z")],
            [],
        );
        expect(day).toMatchObject({raw: 1, excluded: 0, dap: 1, arcadeDap: 1, agentDap: 0});
    });

    test("operator wallets are excluded and reported", () => {
        const [day] = countDailyActivatedPayers([pay(addr(1), "2026-11-02T01:00:00Z"), pay(addr(2), "2026-11-02T01:00:00Z")], [], {
            operatorAllowList: [addr(1).toUpperCase().replace("0X", "0x")],
        });
        expect(day).toMatchObject({raw: 2, excluded: 1, dap: 1});
        expect(day!.excludedPayers).toEqual([{owner: addr(1), reasons: ["operator"]}]);
    });

    test("an owner whose funder funded 3 others is excluded; 2 others is not; public funders are exempt", () => {
        const farmer = addr(0xf0);
        const small = addr(0xf1);
        const faucet = addr(0xfa);
        const funding = [
            ...[1, 2, 3, 4].map((n) => fund(addr(n), farmer, `2026-10-0${n}T01:00:00Z`)),
            ...[5, 6, 7].map((n) => fund(addr(n), small, `2026-10-0${n}T01:00:00Z`)),
            ...[8, 9, 10, 11].map((n) => fund(addr(n), faucet, `2026-10-0${n - 7}T01:00:00Z`)),
        ];
        const payments = [1, 5, 8].map((n) => pay(addr(n), "2026-11-02T01:00:00Z"));
        const [day] = countDailyActivatedPayers(payments, funding, {publicFunders: [faucet]});
        expect(day).toMatchObject({raw: 3, excluded: 1, dap: 2});
        expect(day!.excludedPayers).toEqual([{owner: addr(1), reasons: ["shared-funder"]}]);
    });

    test("5 owners created the same Korean day by one funder are a cluster; thresholds are configurable", () => {
        const funder = addr(0xc0);
        // Created across a UTC midnight but within one Korean day (2026-07-12 KST).
        const funding = [1, 2, 3, 4, 5].map((n) => fund(addr(n), funder, n < 3 ? "2026-07-11T16:00:00Z" : "2026-07-12T10:00:00Z"));
        const payments = [pay(addr(1), "2026-11-02T01:00:00Z")];
        // Shared-funder rule switched off so only the same-day rule can fire.
        const off = {sharedFunderMinOthers: 99};
        expect(countDailyActivatedPayers(payments, funding, off)[0]!.excludedPayers).toEqual([
            {owner: addr(1), reasons: ["same-day-cluster"]},
        ]);
        expect(countDailyActivatedPayers(payments, funding, {...off, sameDayClusterMin: 6})[0]).toMatchObject({excluded: 0, dap: 1});
        // Spread over two Korean days, neither day reaches 5.
        const spread = funding.map((f, i) => (i === 0 ? fund(f.owner, funder, "2026-07-12T15:00:00Z") : f));
        expect(countDailyActivatedPayers(payments, spread, off)[0]).toMatchObject({excluded: 0, dap: 1});
        // With defaults both rules fire and both reasons are reported.
        expect(countDailyActivatedPayers(payments, funding)[0]!.excludedPayers[0]!.reasons).toEqual(["shared-funder", "same-day-cluster"]);
    });

    test("arcade and agent DAP split, an owner paying both counted once in DAP", () => {
        const [day] = countDailyActivatedPayers(
            [
                pay(addr(1), "2026-11-02T01:00:00Z", "arcade"),
                pay(addr(1), "2026-11-02T02:00:00Z", "agent"),
                pay(addr(2), "2026-11-02T03:00:00Z", "agent"),
                pay(addr(3), "2026-11-02T04:00:00Z", "arcade"),
            ],
            [],
        );
        expect(day).toMatchObject({raw: 3, excluded: 0, dap: 3, arcadeDap: 2, agentDap: 2});
    });

    test("payments on other chains are ignored", () => {
        expect(countDailyActivatedPayers([pay(addr(1), "2026-11-02T01:00:00Z", "arcade", "eip155:1")], [])).toEqual([]);
    });

    test("raw, excluded and DAP are reported side by side per day", () => {
        const days = countDailyActivatedPayers(
            [pay(addr(1), "2026-11-03T01:00:00Z"), pay(addr(1), "2026-11-02T01:00:00Z"), pay(addr(2), "2026-11-02T01:00:00Z")],
            [],
            {operatorAllowList: [addr(2)]},
        );
        expect(days).toEqual([
            {day: "2026-11-02", raw: 2, excluded: 1, dap: 1, arcadeDap: 1, agentDap: 0, excludedPayers: [{owner: addr(2), reasons: ["operator"]}]},
            {day: "2026-11-03", raw: 1, excluded: 0, dap: 1, arcadeDap: 1, agentDap: 0, excludedPayers: []},
        ]);
    });
});
