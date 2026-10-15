import {afterEach, describe, expect, test} from 'bun:test';
import type {Address, Hex} from 'viem';
import {ARCADE_RULESET_VERSION, type GameId} from '@mapae/arcade';
import {guardianTraitsHash} from '@mapae/arcade/guardians';
import {addDays, kstWeek, rankedSeed, type RankingBoard, type RankingPage, type RankingStandings} from '@mapae/arcade/ranking';
import {type Season, type SeasonStatus} from '@mapae/arcade/season';
import {OutingStore} from '../outings/store';
import {RankingReader} from './board';
import {GuardianHonorBook} from './honors';
import {createRankingApp} from './routes';

const collection = '0x5555555555555555555555555555555555555555' as Address;
const owner = '0x1111111111111111111111111111111111111111' as Address;
const now = Date.parse('2026-10-14T03:00:00Z'); // Wednesday 12:00 KST; the week began Monday 2026-10-12.
const at = (day: string, minute = 0) => Date.parse(`${day}T03:00:00Z`) + minute * 60_000;
const seedOf = (tokenId: string) => `0x${tokenId.padStart(64, '0')}` as Hex;
const stores: OutingStore[] = [];
afterEach(() => {for (const s of stores.splice(0)) s.close();});
/** Season 1 open since last Monday, so the seller's week seal (Tuesday 00:00 KST) falls inside it. */
const season1: Season = {id: 1, start: '2026-10-05', end: '2026-11-01'};
function setup(season?: Season) {
    const store = new OutingStore(':memory:'); stores.push(store);
    const add = (tokenId: string, game: GameId | string, day: string, attempt: number, score: number, minute = attempt, ruleset = ARCADE_RULESET_VERSION) => {
        store.db.query('INSERT INTO arcade_guardian_ranked VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(`${tokenId}:${game}:${day}:${attempt}:${ruleset}`, collection.toLowerCase(), tokenId,
            seedOf(tokenId), ruleset, game, day, kstWeek(day), attempt, score, 0, at(day, minute));
    };
    return {store, add, reader: new RankingReader(store, collection, () => now, season)};
}

describe('boards', () => {
    test('today ranks each guardian by its best attempt; an equal score goes to whoever reached it first, then the lower token', () => {
        const {add, reader} = setup();
        add('5', 'race', '2026-10-14', 1, 40); add('5', 'race', '2026-10-14', 2, 90, 30);
        add('3', 'race', '2026-10-14', 1, 90, 10);
        add('9', 'race', '2026-10-14', 1, 90, 10); add('2', 'race', '2026-10-14', 1, 10);
        add('4', 'stamp', '2026-10-14', 1, 999); add('6', 'race', '2026-10-13', 1, 999);
        const board = reader.board('race', 'today');
        expect(board).toEqual({board: 'race', period: 'today', from: '2026-10-14', to: '2026-10-14', closesAt: Date.parse('2026-10-14T15:00:00Z'), entrants: 4, moves: true, rows: [
            {rank: 1, tokenId: '3', seed: seedOf('3'), score: 90, prev: null}, {rank: 2, tokenId: '9', seed: seedOf('9'), score: 90, prev: null},
            {rank: 3, tokenId: '5', seed: seedOf('5'), score: 90, prev: null}, {rank: 4, tokenId: '2', seed: seedOf('2'), score: 10, prev: null},
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

describe('movement', () => {
    test('ranks compare with the whole earlier board: up, down, unchanged, new, and a climb from below the shown rows', () => {
        const {add, reader} = setup();
        for (let i = 1; i <= 14; i++) add(String(i), 'race', '2026-10-13', 1, 100 - i);
        add('14', 'race', '2026-10-14', 1, 500); add('1', 'race', '2026-10-14', 1, 400); add('3', 'race', '2026-10-14', 1, 300); add('20', 'race', '2026-10-14', 1, 200);
        const board = reader.board('race', 'today');
        expect(board.moves).toBe(true);
        // Token 14 was 14th, off yesterday's top ten but on the board, so it climbs 13 rather than reading new; token 2 dropped out.
        expect(board.rows.map(r => [r.tokenId, r.rank, r.prev])).toEqual([['14', 1, 14], ['1', 2, 1], ['3', 3, 3], ['20', 4, null]]);
        expect(reader.standings(['14']).guardians[0]!.games.race.today).toMatchObject({rank: 1, moves: true, prev: 14});
        // Yesterday's board compares with the day before, which nobody played: nothing to compare, so no row reads new.
        const yesterday = reader.board('race', 'yesterday');
        expect(yesterday.moves).toBe(false); expect(yesterday.rows.every(r => r.prev === null)).toBe(true);
        expect(reader.board('stamp', 'today')).toMatchObject({moves: false, rows: []});
    });
    test('devotion compares with the 28 days ending yesterday, shared ranks on both sides', () => {
        const {add, reader} = setup();
        for (const day of ['2026-09-16', '2026-10-10', '2026-10-11']) add('1', 'race', day, 1, 1);
        for (const day of ['2026-10-12', '2026-10-13']) add('2', 'stamp', day, 1, 1);
        add('3', 'shop', '2026-10-13', 1, 1); add('3', 'shop', '2026-10-14', 1, 1); add('2', 'shop', '2026-10-14', 1, 1); add('4', 'race', '2026-10-14', 1, 1);
        // Yesterday: 1 had 3 days, 2 had 2, 3 had 1. Today the 16 Sep day ages out of token 1's window.
        expect(reader.board('devotion', '28d').rows.map(r => [r.tokenId, r.rank, r.prev])).toEqual([['2', 1, 2], ['1', 2, 1], ['3', 2, 3], ['4', 4, null]]);
    });
    test('weeks compare with the week before under the same ruleset only', () => {
        const {add, reader} = setup(), old = ARCADE_RULESET_VERSION - 1;
        add('1', 'stamp', '2026-10-06', 1, 50); add('2', 'stamp', '2026-10-06', 1, 40); add('2', 'stamp', '2026-10-13', 1, 70); add('1', 'stamp', '2026-10-13', 1, 30);
        expect(reader.board('stamp', 'week')).toMatchObject({moves: true, rows: [{tokenId: '2', prev: 2}, {tokenId: '1', prev: 1}]});
        expect(reader.standings(['2']).guardians[0]!.games.stamp.week).toMatchObject({rank: 1, moves: true, prev: 2});
        // Last week closed under an older ruleset: its scores came from other courses, so this week shows no movement.
        const bumped = setup();
        bumped.add('5', 'shop', '2026-10-06', 1, 90, 1, old); bumped.add('6', 'shop', '2026-10-07', 1, 80, 1, old); bumped.add('6', 'shop', '2026-09-30', 1, 70, 1, old);
        bumped.add('5', 'shop', '2026-10-13', 1, 10);
        expect(bumped.reader.board('shop', 'week')).toMatchObject({moves: false, rows: [{tokenId: '5', prev: null}]});
        expect(bumped.reader.standings(['5']).guardians[0]!.games.shop.week).toMatchObject({rank: 1, moves: false, prev: null});
        // Last week against the week before: both closed under that same older ruleset, so they compare.
        expect(bumped.reader.board('shop', 'lastweek')).toMatchObject({moves: true, rows: [{tokenId: '5', prev: null}, {tokenId: '6', prev: 1}]});
    });
    test('at midnight KST the day just ended becomes yesterday and still compares with the day before it', () => {
        const {store, add} = setup();
        add('1', 'race', '2026-10-13', 1, 10); add('2', 'race', '2026-10-13', 1, 20); add('1', 'race', '2026-10-14', 1, 30); add('2', 'race', '2026-10-14', 1, 5);
        const at = (instant: number) => new RankingReader(store, collection, () => instant);
        const before = at(Date.parse('2026-10-14T14:59:59Z')), after = at(Date.parse('2026-10-14T15:00:00Z'));
        const moves = [{tokenId: '1', rank: 1, prev: 2}, {tokenId: '2', rank: 2, prev: 1}];
        expect(before.board('race', 'today')).toMatchObject({from: '2026-10-14', moves: true, rows: moves});
        expect(after.board('race', 'today')).toMatchObject({from: '2026-10-15', moves: true, rows: []});
        expect(after.board('race', 'yesterday')).toMatchObject({from: '2026-10-14', moves: true, rows: moves});
    });
});

describe('whole board pages', () => {
    /** 137 entrants today, token n at #n; yesterday the same tokens in reverse, so token n was #(138 − n). */
    function crowd() {
        const s = setup();
        for (let i = 1; i <= 137; i++) {s.add(String(i), 'race', '2026-10-14', 1, 1000 - i); s.add(String(i), 'race', '2026-10-13', 1, 1000 + i);}
        return s;
    }
    const places = (page: RankingPage) => page.rows.map(r => r.rank);
    test('fifty rows from an offset below the top ten, a short last page, and nothing past the end', () => {
        const {reader} = crowd();
        const first = reader.page('race', 'today', {offset: 10});
        expect(first).toMatchObject({board: 'race', period: 'today', from: '2026-10-14', to: '2026-10-14', entrants: 137, moves: true, offset: 10, focus: null});
        expect(places(first)).toEqual(Array.from({length: 50}, (_, i) => 11 + i));
        expect(first.rows[0]).toEqual({rank: 11, tokenId: '11', seed: seedOf('11'), score: 989, prev: 127});
        expect(places(reader.page('race', 'today', {offset: 110}))).toEqual(Array.from({length: 27}, (_, i) => 111 + i));
        expect(reader.page('race', 'today', {offset: 160})).toMatchObject({entrants: 137, offset: 160, rows: []});
        // The top board and the first page meet without a gap or an overlap.
        expect(reader.board('race', 'today').rows.at(-1)!.rank).toBe(10);
        expect(reader.page('stamp', 'today', {offset: 10})).toMatchObject({entrants: 0, moves: false, rows: []});
    });
    test('around finds the page of the best placed named guardian below the top ten', () => {
        const {reader} = crowd();
        const mid = reader.page('race', 'today', {around: ['74']});
        expect(mid).toMatchObject({offset: 60, focus: '74'}); expect(mid.rows.find(r => r.tokenId === '74')).toMatchObject({rank: 74, prev: 64});
        // A guardian in the top ten is already on the board; the next one below it decides the page.
        expect(reader.page('race', 'today', {around: ['5', '74', '120']})).toMatchObject({offset: 60, focus: '74'});
        expect(reader.page('race', 'today', {around: ['11']})).toMatchObject({offset: 10, focus: '11'});
        expect(reader.page('race', 'today', {around: ['137']})).toMatchObject({offset: 110, focus: '137'});
        for (const around of [['5'], ['500']]) expect(reader.page('race', 'today', {around})).toMatchObject({offset: 10, focus: null, rows: expect.any(Array)});
        expect(places(reader.page('race', 'today', {around: ['500']}))[0]).toBe(11);
    });
    test('devotion pages keep shared places across the page edge', () => {
        const {add, reader} = setup();
        // Tokens 1–8 played three days, 9–15 two days, 16 one day: places 1, 9 (shared by seven) and 16.
        for (let i = 1; i <= 16; i++) for (const day of ['2026-10-14', '2026-10-13', '2026-10-12'].slice(0, i <= 8 ? 3 : i <= 15 ? 2 : 1)) add(String(i), 'race', day, 1, 1);
        const page = reader.page('devotion', '28d', {offset: 10});
        expect(page.rows.map(r => [r.tokenId, r.rank, r.score])).toEqual([['11', 9, 2], ['12', 9, 2], ['13', 9, 2], ['14', 9, 2], ['15', 9, 2], ['16', 16, 1]]);
        expect(reader.page('devotion', '28d', {around: ['16']})).toMatchObject({offset: 10, focus: '16'});
    });
    test('no movement on any page after a ruleset change', () => {
        const {add, reader} = setup(), old = ARCADE_RULESET_VERSION - 1;
        for (let i = 1; i <= 12; i++) {add(String(i), 'shop', '2026-10-06', 1, 100 + i, 1, old); add(String(i), 'shop', '2026-10-13', 1, 100 - i);}
        expect(reader.page('shop', 'week', {offset: 10})).toMatchObject({moves: false, rows: [{rank: 11, prev: null}, {rank: 12, prev: null}]});
        // Last week against the week before it: both under the older ruleset, but the week before had nobody, so no comparison either.
        expect(reader.page('shop', 'lastweek', {offset: 10})).toMatchObject({moves: false, rows: [{rank: 11, tokenId: '2', prev: null}, {rank: 12, tokenId: '1', prev: null}]});
    });
});

describe('sealed weeks', () => {
    const late = (day: string) => (Date.parse('2026-10-13T03:00:00Z') - at(day)) / 60_000; // settled Tuesday 12:00 KST, past last week's seal
    test('a round settled after the cutoff never changes the closed week board', () => {
        const {add, reader} = setup();
        add('1', 'race', '2026-10-07', 1, 50); add('2', 'race', '2026-10-08', 1, 40);
        const before = reader.board('race', 'lastweek');
        add('3', 'race', '2026-10-11', 1, 999, late('2026-10-11')); add('2', 'race', '2026-10-11', 1, 999, late('2026-10-11'));
        expect(reader.board('race', 'lastweek')).toEqual(before);
        expect(before.rows.map(r => [r.tokenId, r.score])).toEqual([['1', 50], ['2', 40]]);
        // Inside the grace day a late settlement still counts.
        add('4', 'race', '2026-10-11', 1, 60, (Date.parse('2026-10-12T14:59:00Z') - at('2026-10-11')) / 60_000);
        expect(reader.board('race', 'lastweek').rows[0]!.tokenId).toBe('4');
    });
    test('a closed week keeps the ruleset it closed under after a bump; the open week takes the current one', () => {
        const {add, reader} = setup(), old = ARCADE_RULESET_VERSION - 1;
        add('1', 'shop', '2026-10-06', 1, 70, 1, old); add('2', 'shop', '2026-10-07', 1, 60, 1, old);
        add('3', 'shop', '2026-10-13', 1, 80, 1, old);
        expect(reader.board('shop', 'lastweek').rows.map(r => r.tokenId)).toEqual(['1', '2']);
        expect(reader.board('shop', 'week').rows).toEqual([]);
        expect(reader.standings(['1']).guardians[0]!.titles).toEqual([{game: 'shop', place: 1}]);
        // Once the week closed under a newer ruleset, only that ruleset's rows rank it.
        add('4', 'stamp', '2026-10-09', 1, 5);
        expect(reader.board('shop', 'lastweek').rows).toEqual([]);
    });
});

describe('honor book', () => {
    const tuesday = Date.parse('2026-10-12T15:00:00Z'); // last week (2026-10-05, week 2961) seals now
    test('nothing before the seal; titles add up across sealed weeks; the longest run counts only rows settled before the cutoff', () => {
        const {store, add} = setup(), book = new GuardianHonorBook(store.db, collection);
        for (const day of ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-06']) add('1', 'stamp', day, 1, 10);
        add('1', 'stamp', '2026-10-07', 1, 10);
        add('2', 'race', '2026-10-06', 1, 90); add('1', 'race', '2026-10-06', 1, 50); add('3', 'race', '2026-10-06', 1, 10);
        expect(book.honor('1', tuesday - 1)).toEqual({week: 2960, longestStreak: 3, titles: [{champion: 1, podium: 0, top10: 0}, {champion: 0, podium: 0, top10: 0}, {champion: 0, podium: 0, top10: 0}]});
        expect(book.honor('9', tuesday - 1)).toBeNull();
        expect(book.honor('1', Date.parse('2026-09-28T15:00:00Z'))).toBeNull();
        const sealed = {week: 2961, longestStreak: 3, titles: [{champion: 2, podium: 0, top10: 0}, {champion: 0, podium: 1, top10: 0}, {champion: 0, podium: 0, top10: 0}]};
        expect(book.honor('1', tuesday)).toEqual(sealed);
        expect(book.honor('3', tuesday)).toMatchObject({week: 2961, longestStreak: 1, titles: [{champion: 0}, {podium: 1}, {top10: 0}]});
        // A late round would have joined the run and taken the race crown; both settled after the seal, so neither counts.
        add('1', 'stamp', '2026-10-03', 1, 10, (Date.parse('2026-10-13T00:00:00Z') - at('2026-10-03')) / 60_000);
        add('1', 'stamp', '2026-10-04', 1, 10, (Date.parse('2026-10-13T00:00:00Z') - at('2026-10-04')) / 60_000);
        add('1', 'stamp', '2026-10-05', 1, 10, (Date.parse('2026-10-13T00:00:00Z') - at('2026-10-05')) / 60_000);
        add('1', 'race', '2026-10-08', 1, 999, (Date.parse('2026-10-13T00:00:00Z') - at('2026-10-08')) / 60_000);
        expect(book.honor('1', now)).toEqual(sealed);
        expect(store.db.query('SELECT week, game, token_id, place FROM arcade_guardian_titles ORDER BY week, game, place').all()).toEqual([
            {week: '2026-09-28', game: 'stamp', token_id: '1', place: 1},
            {week: '2026-10-05', game: 'race', token_id: '2', place: 1}, {week: '2026-10-05', game: 'race', token_id: '1', place: 2}, {week: '2026-10-05', game: 'race', token_id: '3', place: 3},
            {week: '2026-10-05', game: 'stamp', token_id: '1', place: 1},
        ]);
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
        expect(mine.games.race.today).toEqual({rank: 12, score: 88, moves: false, prev: null, entrants: 15, leader: 99, above: {rank: 11, tokenId: '11', seed: seedOf('11'), score: 89},
            nearby: [10, 11, 12, 13, 14].map(n => ({rank: n, tokenId: String(n), seed: seedOf(String(n)), score: 100 - n}))});
        expect(mine.games.shop).toMatchObject({attemptsUsed: 0, today: null, week: {rank: 1, score: 6, above: null}});
        expect(mine.games.stamp).toEqual({attemptsUsed: 0, today: null, week: null});
        expect(mine.streak).toEqual({current: 3, best: 3, freezes: 0, playedToday: true});
        expect(mine.devotion).toEqual({rank: 1, days: 4});
        expect(mine.titles).toEqual([{game: 'shop', place: 2}]);
        expect(standings.guardians[1]).toEqual({tokenId: '40', streak: {current: 0, best: 0, freezes: 0, playedToday: false}, devotion: {rank: null, days: 0}, season: null, titles: [],
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
        for (const path of ['/board/xp/today', '/board/race/28d', '/board/devotion/today', '/board/season/s2', '/board/season/today', '/board/race/s1', '/guardians/2,1', '/guardians/1,1',
            '/guardians/1,2,3,4', '/guardians/0', '/guardians/10001'])
            expect((await app.request(path, {headers: auth})).status).toBe(400);
        expect((await app.request('/board/race/today/from/10', {headers: auth})).status).toBe(200);
        expect((await app.request('/board/devotion/28d/around/1,3', {headers: auth})).status).toBe(200);
        for (const path of ['/board/race/today/from/0', '/board/race/today/from/9', '/board/race/today/from/11', '/board/race/today/from/010', '/board/race/today/from/10010',
            '/board/race/today/around/2,1', '/board/race/today/around/0', '/board/race/today/at/10', '/board/race/28d/from/10', '/board/xp/today/around/1'])
            expect((await app.request(path, {headers: auth})).status).toBe(400);
        expect((await createRankingApp({token}).request('/board/race/today', {headers: auth})).status).toBe(503);
        expect((await createRankingApp({token}).request('/board/race/today/from/10', {headers: auth})).status).toBe(503);
        expect((await createRankingApp({}).request('/board/race/today', {headers: auth})).status).toBe(401);
    });
    test('responses never carry an actor, payer, payment or owner', async () => {
        const {add, reader} = setup(season1); add('1', 'race', '2026-10-14', 1, 50); add('1', 'race', '2026-10-06', 1, 50);
        const app = createRankingApp({token, reader});
        for (const path of ['/board/race/today', '/board/race/lastweek', '/board/devotion/28d', '/board/race/today/from/10', '/board/race/today/around/1', '/guardians/1', '/season',
            '/board/season/s1', '/board/season/s1/from/10', '/board/season/s1/around/1']) {
            const body = await (await app.request(path, {headers: auth})).text();
            for (const key of ['actor', 'payer', 'transaction', 'paymentTx', 'payment_tx', 'owner', '0x1111']) expect(body).not.toContain(key);
        }
        const standings = await (await app.request('/guardians/1', {headers: auth})).json() as RankingStandings;
        expect(standings.guardians[0]!.titles).toEqual([{game: 'race', place: 1}]);
    });
});

describe('season', () => {
    const rows = (board: RankingBoard | RankingPage) => board.rows.map(r => [r.tokenId, r.rank, r.score, r.prev, r.days, r.streak]);
    test('each day pays 10, 7, 5, 3 to the top ten and 1 to every other entrant, per game; totals share places and compare with yesterday', () => {
        const {add, reader} = setup(season1);
        for (let i = 1; i <= 11; i++) add(String(i), 'race', '2026-10-13', 1, 100 - i);
        add('11', 'shop', '2026-10-14', 1, 50); add('1', 'shop', '2026-10-14', 1, 40);
        const board = reader.board('season', 's1');
        expect(board).toMatchObject({board: 'season', period: 's1', from: '2026-10-05', to: '2026-10-14', closesAt: Date.parse('2026-11-01T15:00:00Z'), entrants: 11, moves: true});
        expect(rows(board)).toEqual([['1', 1, 17, 1, 2, 2], ['11', 2, 11, 11, 2, 2], ['2', 3, 7, 2, 1, 1], ['3', 4, 5, 3, 1, 1],
            ...['4', '5', '6', '7', '8', '9'].map(id => [id, 5, 3, 4, 1, 1])]);
        expect(board.rows[0]!.seed).toBe(seedOf('1'));
        const mine = reader.standings(['11', '2', '40']).guardians;
        expect(mine[0]!.season).toEqual({moves: true, prev: 11, points: 11, rank: 2, entrants: 11, days: 2, streak: 2, bonus: 0, today: 10});
        expect(mine[1]!.season).toMatchObject({rank: 3, prev: 2, today: 0, streak: 1}); expect(mine[2]!.season).toBeNull();
    });
    test('an equal daily score pays whoever reached it first, then the lower token; three wins make the daily thirty', () => {
        const {add, reader} = setup(season1);
        add('9', 'stamp', '2026-10-14', 1, 90, 10); add('3', 'stamp', '2026-10-14', 1, 90, 10); add('5', 'stamp', '2026-10-14', 1, 90, 30);
        for (const game of ['race', 'shop', 'stamp'] as const) add('7', game, '2026-10-14', 1, 999, 40);
        expect(rows(reader.board('season', 's1'))).toEqual([['7', 1, 30, null, 1, 1], ['3', 2, 7, null, 1, 1], ['9', 3, 5, null, 1, 1], ['5', 4, 3, null, 1, 1]]);
        expect(reader.board('season', 's1').moves).toBe(false);
    });
    test('only the season\'s days count, the window stops at the end, and a closed season has no clock', () => {
        const {add, reader} = setup(season1);
        add('1', 'race', '2026-10-04', 1, 50); add('2', 'race', '2026-10-05', 1, 50);
        expect(rows(reader.board('season', 's1'))).toEqual([['2', 1, 10, 1, 1, 0]]);
        const short = setup({id: 1, start: '2026-10-05', end: '2026-10-10'});
        short.add('1', 'race', '2026-10-10', 1, 50); short.add('1', 'race', '2026-10-09', 1, 50); short.add('2', 'race', '2026-10-11', 1, 50);
        expect(short.reader.board('season', 's1')).toMatchObject({from: '2026-10-05', to: '2026-10-10', closesAt: null, entrants: 1, moves: true, rows: [{tokenId: '1', score: 20, prev: 1, days: 2, streak: 2}]});
        expect(short.reader.standings(['1']).guardians[0]!.season).toMatchObject({points: 20, rank: 1, today: 10});
    });
    test('a round settled after its week sealed never adds points; the open week takes every settlement', () => {
        const {add, reader} = setup(season1), late = (day: string, iso: string) => (Date.parse(iso) - at(day)) / 60_000;
        add('2', 'race', '2026-10-11', 1, 50); add('3', 'race', '2026-10-11', 1, 999, late('2026-10-11', '2026-10-13T03:00:00Z'));
        add('4', 'race', '2026-10-11', 1, 60, late('2026-10-11', '2026-10-12T14:59:00Z'));
        add('5', 'race', '2026-10-12', 1, 10, late('2026-10-12', '2026-10-14T02:00:00Z'));
        expect(rows(reader.board('season', 's1')).map(r => r.slice(0, 3))).toEqual([['4', 1, 10], ['5', 1, 10], ['2', 3, 7]]);
    });
    test('a day ranks under the highest ruleset played that day, so a bump mid-season keeps earlier days whole', () => {
        const {add, reader} = setup(season1), old = ARCADE_RULESET_VERSION - 1;
        add('1', 'shop', '2026-10-12', 1, 5, 1, old);
        add('1', 'shop', '2026-10-13', 1, 999, 1, old); add('2', 'shop', '2026-10-13', 1, 10);
        expect(rows(reader.board('season', 's1')).map(r => r.slice(0, 3))).toEqual([['1', 1, 10], ['2', 1, 10]]);
    });
    test('every seven-day attendance run inside the season adds ten; a rest day keeps the run', () => {
        const {add, reader} = setup(season1);
        for (const day of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-13', '2026-10-14']) add('1', 'race', day, 1, 100);
        for (const day of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']) add('2', 'race', day, 1, 50);
        expect(rows(reader.board('season', 's1'))).toEqual([['1', 1, 100, 1, 9, 9], ['2', 2, 42, 2, 6, 0]]);
        expect(reader.standings(['1', '2']).guardians.map(g => g.season)).toEqual([
            {moves: true, prev: 1, points: 100, rank: 1, entrants: 2, days: 9, streak: 9, bonus: 10, today: 10},
            {moves: true, prev: 2, points: 42, rank: 2, entrants: 2, days: 6, streak: 0, bonus: 0, today: 0}]);
        // A run that began before the season only counts from its first day: six days before plus one inside is a one-day run.
        const spill = setup(season1);
        for (let i = -6; i <= 0; i++) spill.add('3', 'race', addDays('2026-10-05', i), 1, 1);
        expect(rows(spill.reader.board('season', 's1'))).toEqual([['3', 1, 10, 1, 1, 0]]);
    });
    test('pages and around lookups work on the season board; the first day compares with nothing', () => {
        const {add, reader} = setup(season1);
        for (let i = 1; i <= 60; i++) {add(String(i), 'race', '2026-10-13', 1, 1000 - i); add(String(i), 'race', '2026-10-14', 1, 1000 + i);}
        const page = reader.page('season', 's1', {offset: 10});
        expect(page).toMatchObject({board: 'season', period: 's1', from: '2026-10-05', to: '2026-10-14', entrants: 60, moves: true, offset: 10, focus: null});
        // Token n placed #n yesterday and #(61 − n) today, so places pair up and share: 1, 1, 3, 3, 5, 5, then fourteen at #7 and forty at #21.
        expect(page.rows).toHaveLength(50); expect(page.rows[0]).toMatchObject({rank: 7, days: 2, streak: 2}); expect(page.rows[20]).toMatchObject({rank: 21, score: 2});
        expect(page.rows.every(r => typeof r.prev === 'number')).toBe(true);
        expect(reader.page('season', 's1', {around: ['1', '30']})).toMatchObject({offset: 10, focus: '30'});
        const opening = setup({id: 1, start: '2026-10-14', end: '2026-11-01'});
        opening.add('1', 'race', '2026-10-13', 1, 5); opening.add('1', 'race', '2026-10-14', 1, 5);
        expect(opening.reader.board('season', 's1')).toMatchObject({from: '2026-10-14', to: '2026-10-14', moves: false, rows: [{tokenId: '1', score: 10, prev: null, days: 1, streak: 1}]});
        expect(opening.reader.page('season', 's1', {offset: 10})).toMatchObject({moves: false, rows: []});
    });
    test('the status says the phase; before the season opens the board is a bad request and standings carry no season', async () => {
        const token = 'ranking-bridge-token'.repeat(3), auth = {Authorization: `Bearer ${token}`};
        const pending = setup(); pending.add('1', 'race', '2026-10-14', 1, 50);
        let app = createRankingApp({token, reader: pending.reader});
        expect(await (await app.request('/season', {headers: auth})).json<SeasonStatus>()).toEqual({id: 1, start: null, end: null, today: '2026-10-14', phase: 'pending'});
        expect((await app.request('/board/season/s1', {headers: auth})).status).toBe(400);
        expect((await app.request('/board/season/s1/from/10', {headers: auth})).status).toBe(400);
        expect(pending.reader.standings(['1']).guardians[0]!.season).toBeNull();
        const announced = setup({id: 1, start: '2026-10-19', end: '2026-11-15'});
        expect(announced.reader.seasonStatus()).toMatchObject({phase: 'announced'});
        expect(() => announced.reader.board('season', 's1')).toThrow();
        const open = setup(season1); open.add('1', 'race', '2026-10-14', 1, 50);
        app = createRankingApp({token, reader: open.reader});
        expect(await (await app.request('/season', {headers: auth})).json<SeasonStatus>()).toEqual({id: 1, start: '2026-10-05', end: '2026-11-01', today: '2026-10-14', phase: 'open'});
        expect((await app.request('/board/season/s1', {headers: auth})).status).toBe(200);
        expect((await app.request('/board/season/s1/around/1', {headers: auth})).status).toBe(200);
        expect((await app.request('/season')).status).toBe(401);
        expect((await createRankingApp({token}).request('/season', {headers: auth})).status).toBe(503);
    });
});
