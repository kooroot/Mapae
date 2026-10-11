import {afterEach, describe, expect, test} from 'bun:test';
import type {Address, Hex} from 'viem';
import {ARCADE_RULESET_VERSION, type GameId} from '@mapae/arcade';
import {guardianTraitsHash} from '@mapae/arcade/guardians';
import {addDays, kstWeek, rankedSeed, type RankingBoard, type RankingStandings} from '@mapae/arcade/ranking';
import {OutingStore} from '../outings/store';
import {RankingReader} from './board';
import {createRankingApp} from './routes';

const collection = '0x5555555555555555555555555555555555555555' as Address;
const owner = '0x1111111111111111111111111111111111111111' as Address;
const now = Date.parse('2026-10-14T03:00:00Z'); // Wednesday 12:00 KST; the week began Monday 2026-10-12.
const at = (day: string, minute = 0) => Date.parse(`${day}T03:00:00Z`) + minute * 60_000;
const seedOf = (tokenId: string) => `0x${tokenId.padStart(64, '0')}` as Hex;
const stores: OutingStore[] = [];
afterEach(() => {for (const s of stores.splice(0)) s.close();});
function setup() {
    const store = new OutingStore(':memory:'); stores.push(store);
    const add = (tokenId: string, game: GameId | string, day: string, attempt: number, score: number, minute = attempt, ruleset = ARCADE_RULESET_VERSION) => {
        store.db.query('INSERT INTO arcade_guardian_ranked VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(`${tokenId}:${game}:${day}:${attempt}:${ruleset}`, collection.toLowerCase(), tokenId,
            seedOf(tokenId), ruleset, game, day, kstWeek(day), attempt, score, 0, at(day, minute));
    };
    return {store, add, reader: new RankingReader(store, collection, () => now)};
}

describe('boards', () => {
    test('today ranks each guardian by its best attempt; an equal score goes to whoever reached it first, then the lower token', () => {
        const {add, reader} = setup();
        add('5', 'race', '2026-10-14', 1, 40); add('5', 'race', '2026-10-14', 2, 90, 30);
        add('3', 'race', '2026-10-14', 1, 90, 10);
        add('9', 'race', '2026-10-14', 1, 90, 10); add('2', 'race', '2026-10-14', 1, 10);
        add('4', 'stamp', '2026-10-14', 1, 999); add('6', 'race', '2026-10-13', 1, 999);
        const board = reader.board('race', 'today');
        expect(board).toEqual({board: 'race', period: 'today', from: '2026-10-14', to: '2026-10-14', closesAt: Date.parse('2026-10-14T15:00:00Z'), entrants: 4, rows: [
            {rank: 1, tokenId: '3', seed: seedOf('3'), score: 90}, {rank: 2, tokenId: '9', seed: seedOf('9'), score: 90},
            {rank: 3, tokenId: '5', seed: seedOf('5'), score: 90}, {rank: 4, tokenId: '2', seed: seedOf('2'), score: 10},
        ]});
        expect(reader.board('race', 'yesterday')).toMatchObject({from: '2026-10-13', closesAt: null, entrants: 1});
    });
    test('only the current ruleset ranks, and a board shows ten rows of every entrant', () => {
        const {add, reader} = setup();
        add('1', 'shop', '2026-10-14', 1, 5000, 1, ARCADE_RULESET_VERSION - 1);
        for (let i = 2; i <= 13; i++) add(String(i), 'shop', '2026-10-14', 1, i);
        const board = reader.board('shop', 'today');
        expect(board.entrants).toBe(12); expect(board.rows).toHaveLength(10); expect(board.rows[0]!.tokenId).toBe('13');
    });
    test('the week adds the best five of seven daily bests; an equal total goes to whoever completed it first', () => {
        const {add, reader} = setup();
        const days = ['2026-10-12', '2026-10-13', '2026-10-14'];
        // Token 7 plays seven days last week; only the best five days count.
        for (let i = 0; i < 7; i++) add('7', 'stamp', addDays('2026-10-05', i), 1, 10 * (i + 1));
        add('7', 'stamp', '2026-10-11', 2, 5);
        add('8', 'stamp', '2026-10-05', 1, 250);
        days.forEach((day, i) => {add('1', 'stamp', day, 1, 10); add('1', 'stamp', day, 2, 20 + i);});
        add('2', 'stamp', '2026-10-12', 1, 66); add('3', 'stamp', '2026-10-13', 1, 66, 0);
        const week = reader.board('stamp', 'week');
        expect(week).toMatchObject({from: '2026-10-12', to: '2026-10-18', closesAt: Date.parse('2026-10-18T15:00:00Z'), entrants: 3});
        expect(week.rows.map(r => [r.tokenId, r.score])).toEqual([['2', 66], ['3', 66], ['1', 63]]);
        const last = reader.board('stamp', 'lastweek');
        expect(last).toMatchObject({from: '2026-10-05', to: '2026-10-11', closesAt: null});
        // Equal totals: token 8 completed its 250 on Monday, token 7 only on Sunday.
        expect(last.rows.map(r => [r.tokenId, r.score])).toEqual([['8', 250], ['7', 30 + 40 + 50 + 60 + 70]]);
    });
    test('devotion counts distinct ranked days in the last 28 KST days, across games and rulesets, with shared ranks', () => {
        const {add, reader} = setup();
        add('1', 'race', '2026-10-14', 1, 1); add('1', 'shop', '2026-10-14', 1, 1); add('1', 'race', '2026-09-17', 1, 1);
        add('1', 'race', '2026-09-16', 1, 1); // 28 days back is outside
        add('2', 'stamp', '2026-10-01', 1, 1, 1, ARCADE_RULESET_VERSION - 1); add('2', 'stamp', '2026-10-02', 1, 1);
        add('3', 'stamp', '2026-10-03', 1, 1);
        const board = reader.board('devotion', '28d');
        expect(board).toMatchObject({from: '2026-09-17', to: '2026-10-14', closesAt: Date.parse('2026-10-14T15:00:00Z'), entrants: 3});
        expect(board.rows.map(r => [r.rank, r.tokenId, r.score])).toEqual([[1, '1', 2], [1, '2', 2], [3, '3', 1]]);
    });
});

describe('standings', () => {
    test('rank, leader, the guardian above, two either side, pending attempts, streak, titles and unknown tokens', () => {
        const {store, add, reader} = setup();
        for (let i = 1; i <= 15; i++) add(String(i), 'race', '2026-10-14', 1, 100 - i);
        add('12', 'race', '2026-10-14', 2, 1);
        for (const day of ['2026-10-12', '2026-10-13']) add('12', 'shop', day, 1, 3);
        add('12', 'shop', '2026-10-06', 1, 77); add('20', 'shop', '2026-10-06', 1, 80);
        // An active outing's pending ranked admission counts as used.
        store.db.query("INSERT INTO arcade_outings VALUES (?,?,?,?,?,?)").run('pending-job', owner.toLowerCase(), `0x${'aa'.repeat(32)}`, now, 'queued', JSON.stringify({
            id: 'pending-job', guardian: {chainId: 91342, collection, tokenId: '12', owner, ownershipEpoch: '1', seed: seedOf('12'), traitsHash: guardianTraitsHash(seedOf('12')), ruleset: ARCADE_RULESET_VERSION},
            pending: {game: 'race', seed: rankedSeed('race', '2026-10-14', 3, '12'), header: 'h', transaction: null, ranked: {day: '2026-10-14', attempt: 3}}}));
        const standings = reader.standings(['12', '40']);
        expect(standings).toMatchObject({day: '2026-10-14', week: '2026-10-12', closesAt: {day: Date.parse('2026-10-14T15:00:00Z'), week: Date.parse('2026-10-18T15:00:00Z')},
            leaders: {race: 99, shop: null, stamp: null}});
        const mine = standings.guardians[0]!;
        expect(mine.games.race.attemptsUsed).toBe(3);
        expect(mine.games.race.today).toEqual({rank: 12, score: 88, entrants: 15, leader: 99, above: {rank: 11, tokenId: '11', seed: seedOf('11'), score: 89},
            nearby: [10, 11, 12, 13, 14].map(n => ({rank: n, tokenId: String(n), seed: seedOf(String(n)), score: 100 - n}))});
        expect(mine.games.shop).toMatchObject({attemptsUsed: 0, today: null, week: {rank: 1, score: 6, above: null}});
        expect(mine.games.stamp).toEqual({attemptsUsed: 0, today: null, week: null});
        expect(mine.streak).toEqual({current: 3, best: 3, freezes: 0, playedToday: true});
        expect(mine.devotion).toEqual({rank: 1, days: 4});
        expect(mine.titles).toEqual([{game: 'shop', place: 2}]);
        expect(standings.guardians[1]).toEqual({tokenId: '40', streak: {current: 0, best: 0, freezes: 0, playedToday: false}, devotion: {rank: null, days: 0}, titles: [],
            games: {stamp: {attemptsUsed: 0, today: null, week: null}, race: {attemptsUsed: 0, today: null, week: null}, shop: {attemptsUsed: 0, today: null, week: null}}});
    });
});

describe('routes', () => {
    const token = 'ranking-bridge-token'.repeat(3), auth = {Authorization: `Bearer ${token}`};
    test('bearer only, no owner header, strict board and id shapes', async () => {
        const {add, reader} = setup(); add('1', 'race', '2026-10-14', 1, 50);
        const app = createRankingApp({token, reader});
        expect((await app.request('/board/race/today')).status).toBe(401);
        expect((await app.request('/board/race/today', {headers: {Authorization: 'Bearer wrong'}})).status).toBe(401);
        const ok = await app.request('/board/race/today', {headers: auth});
        expect(ok.status).toBe(200); expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
        expect(((await ok.json()) as RankingBoard).rows[0]!.tokenId).toBe('1');
        expect((await app.request('/guardians/1,2', {headers: auth})).status).toBe(200);
        for (const path of ['/board/xp/today', '/board/race/28d', '/board/devotion/today', '/guardians/2,1', '/guardians/1,1', '/guardians/1,2,3,4', '/guardians/0', '/guardians/10001'])
            expect((await app.request(path, {headers: auth})).status).toBe(400);
        expect((await createRankingApp({token}).request('/board/race/today', {headers: auth})).status).toBe(503);
        expect((await createRankingApp({}).request('/board/race/today', {headers: auth})).status).toBe(401);
    });
    test('responses never carry an actor, payer, payment or owner', async () => {
        const {add, reader} = setup(); add('1', 'race', '2026-10-14', 1, 50); add('1', 'race', '2026-10-06', 1, 50);
        const app = createRankingApp({token, reader});
        for (const path of ['/board/race/today', '/board/race/lastweek', '/board/devotion/28d', '/guardians/1']) {
            const body = await (await app.request(path, {headers: auth})).text();
            for (const key of ['actor', 'payer', 'transaction', 'paymentTx', 'payment_tx', 'owner', '0x1111']) expect(body).not.toContain(key);
        }
        const standings = await (await app.request('/guardians/1', {headers: auth})).json() as RankingStandings;
        expect(standings.guardians[0]!.titles).toEqual([{game: 'race', place: 1}]);
    });
});
