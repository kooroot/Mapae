import type {Database} from 'bun:sqlite';
import type {Address} from 'viem';
import {emptyHonors, type GuardianHonors} from '@mapae/arcade/guardians';
import {addDays, BOARD_ROWS, guardianStreak, RANKED_GAMES, rankingWeekIndex, sealedWeek, titlePlace, weekCutoff} from '@mapae/arcade/ranking';
import {weekBoard} from './board';

const LANE_MAX = 0xffff;

/**
 * A guardian's cumulative ranking honors as of the latest sealed week: what one signed Honor attests on the NFT. Sealed week
 * boards cannot change (rows settled after the cutoff never count), so their top ten are memoised once per week; the memo is a
 * pure cache of deterministic data. Honors confirmed on-chain are not stored here: the token's own slot is the watermark.
 */
export class GuardianHonorBook {
    constructor(readonly db: Database, readonly collection: Address) {
        db.exec(`CREATE TABLE IF NOT EXISTS arcade_guardian_title_weeks(collection TEXT NOT NULL, week TEXT NOT NULL, PRIMARY KEY(collection, week));
            CREATE TABLE IF NOT EXISTS arcade_guardian_titles(
                collection TEXT NOT NULL, week TEXT NOT NULL, game TEXT NOT NULL, token_id TEXT NOT NULL, place INTEGER NOT NULL,
                PRIMARY KEY(collection, week, game, token_id));
            CREATE INDEX IF NOT EXISTS guardian_titles_token ON arcade_guardian_titles(collection, token_id, week);`);
    }

    /** Memoises the title holders of every sealed week not yet memoised; returns the latest sealed week. */
    seal(at: number): string | null {
        const sealed = sealedWeek(at), c = this.collection.toLowerCase();
        if (!sealed) return null;
        this.db.transaction(() => {
            const first = this.db.query<{week: string | null}, [string]>('SELECT MIN(week) AS week FROM arcade_guardian_ranked WHERE collection=?').get(c)?.week;
            if (!first) return;
            const done = new Set(this.db.query<{week: string}, [string]>('SELECT week FROM arcade_guardian_title_weeks WHERE collection=?').all(c).map(r => r.week));
            const title = this.db.query('INSERT INTO arcade_guardian_titles VALUES (?,?,?,?,?)'), mark = this.db.query('INSERT INTO arcade_guardian_title_weeks VALUES (?,?)');
            for (let week = first; week <= sealed; week = addDays(week, 7)) {
                if (done.has(week)) continue;
                for (const game of RANKED_GAMES) for (const row of weekBoard(this.db, this.collection, game, week, at).slice(0, BOARD_ROWS)) title.run(c, week, game, row.tokenId, row.rank);
                mark.run(c, week);
            }
        })();
        return sealed;
    }

    /** Titles over every sealed week and the longest attendance streak through the sealed week; null when there is nothing to attest. */
    honor(tokenId: string, at: number): GuardianHonors | null {
        const sealed = this.seal(at), c = this.collection.toLowerCase();
        if (!sealed) return null;
        const honors = emptyHonors();
        for (const row of this.db.query<{game: string; place: number}, [string, string, string]>(
            'SELECT game, place FROM arcade_guardian_titles WHERE collection=? AND token_id=? AND week<=?').all(c, tokenId, sealed)) {
            const game = honors.titles[RANKED_GAMES.indexOf(row.game as typeof RANKED_GAMES[number])], tier = titlePlace(row.place);
            if (game && tier) game[tier] = Math.min(LANE_MAX, game[tier] + 1);
        }
        // All history, not the board's one-year window: the longest run is a lifetime fact, and only rows settled before the seal count.
        const last = addDays(sealed, 6), days = this.db.query<{day: string}, [string, string, string, number]>(
            'SELECT DISTINCT day FROM arcade_guardian_ranked WHERE collection=? AND token_id=? AND day<=? AND created_at<? ORDER BY day')
            .all(c, tokenId, last, weekCutoff(sealed)).map(r => r.day);
        honors.longestStreak = Math.min(LANE_MAX, guardianStreak(days, last).best);
        if (!honors.longestStreak && honors.titles.every(t => !t.champion && !t.podium && !t.top10)) return null;
        honors.week = rankingWeekIndex(sealed);
        return honors;
    }
}
