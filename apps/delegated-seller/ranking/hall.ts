import type {Database} from 'bun:sqlite';
import type {Address} from 'viem';
import type {SealedHall} from '@mapae/arcade/hall';

/**
 * The sealed hall of fame of each season, kept as the JSON the web reads: a sealed season is a fact, so it is computed once and
 * never recomputed — a late settlement, a ruleset bump or a new season id never changes what season 1 left behind. One row per
 * season; writes go through `transaction().immediate()` so two first reads cannot seal twice.
 */
export class SeasonHallBook {
    constructor(readonly db: Database, readonly collection: Address) {
        db.exec('CREATE TABLE IF NOT EXISTS arcade_season_hall(collection TEXT NOT NULL, season INTEGER NOT NULL, sealed_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection, season))');
    }
    get(season: number): SealedHall | null {
        const row = this.db.query<{data: string}, [string, number]>('SELECT data FROM arcade_season_hall WHERE collection=? AND season=?').get(this.collection.toLowerCase(), season);
        return row ? JSON.parse(row.data) as SealedHall : null;
    }
    /** Stores the hall `build` computes unless the season was sealed meanwhile; returns the hall on record either way. */
    seal(season: number, build: () => SealedHall): SealedHall {
        return this.db.transaction(() => {
            const held = this.get(season);
            if (held) return held;
            const hall = build();
            this.db.query('INSERT INTO arcade_season_hall VALUES (?,?,?,?)').run(this.collection.toLowerCase(), season, hall.sealedAt, JSON.stringify(hall));
            return hall;
        }).immediate();
    }
}
