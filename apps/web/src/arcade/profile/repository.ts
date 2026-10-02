import type {D1Database} from "@cloudflare/workers-types";
import {emptyProfile, parseProfile, type Profile, type ProfileSnapshot} from "./model";

type Identity = {owner: string; origin: string; expires_at: number};
export type Challenge = Identity & {message: string};
export interface ProfileRepository {
    rateLimit(bucket: string, until: number, limit: number): Promise<boolean>;
    challenge(hash: string, value: Challenge): Promise<void>;
    consumeChallenge(hash: string, origin: string, now: number): Promise<Challenge | null>;
    session(hash: string, value: Identity): Promise<void>;
    identity(hash: string, origin: string, now: number): Promise<Identity | null>;
    logout(hash: string): Promise<void>;
    read(owner: string): Promise<ProfileSnapshot>;
    write(owner: string, revision: number, profile: Profile, now: number): Promise<boolean>;
    cleanup(now: number): Promise<void>;
}
/** SQL conditions, not process memory, serialize replay prevention and concurrent saves. */
export function profileRepository(db: Pick<D1Database, "prepare" | "batch">): ProfileRepository {
    return {
        async rateLimit(bucket, until, limit) {
            const row = await db.prepare("INSERT INTO arcade_auth_limits (bucket, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count").bind(bucket, until, limit).first();
            return !!row;
        },
        async challenge(hash, v) {await db.prepare("INSERT INTO arcade_login_challenges (token_hash, owner, origin, message, expires_at) VALUES (?, ?, ?, ?, ?)").bind(hash, v.owner, v.origin, v.message, v.expires_at).run();},
        consumeChallenge(hash, origin, now) {return db.prepare("DELETE FROM arcade_login_challenges WHERE token_hash = ? AND origin = ? AND expires_at > ? RETURNING owner, origin, message, expires_at").bind(hash, origin, now).first<Challenge>();},
        async session(hash, v) {await db.prepare("INSERT INTO arcade_sessions (token_hash, owner, origin, expires_at) VALUES (?, ?, ?, ?)").bind(hash, v.owner, v.origin, v.expires_at).run();},
        identity(hash, origin, now) {return db.prepare("SELECT owner, origin, expires_at FROM arcade_sessions WHERE token_hash = ? AND origin = ? AND expires_at > ?").bind(hash, origin, now).first<Identity>();},
        async logout(hash) {await db.prepare("DELETE FROM arcade_sessions WHERE token_hash = ?").bind(hash).run();},
        async read(owner) {
            const row = await db.prepare("SELECT revision, profile FROM arcade_profiles WHERE owner = ?").bind(owner).first<{revision: number; profile: string}>();
            if (!row) return {owner, revision: 0, profile: emptyProfile()};
            const profile = parseProfile(JSON.parse(row.profile));
            if (!profile) throw new Error("Stored profile is invalid");
            return {owner, revision: row.revision, profile};
        },
        async write(owner, revision, profile, now) {
            const row = revision === 0
                ? await db.prepare("INSERT INTO arcade_profiles (owner, revision, profile, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(owner) DO NOTHING RETURNING revision").bind(owner, JSON.stringify(profile), now).first()
                : await db.prepare("UPDATE arcade_profiles SET revision = revision + 1, profile = ?, updated_at = ? WHERE owner = ? AND revision = ? RETURNING revision").bind(JSON.stringify(profile), now, owner, revision).first();
            return !!row;
        },
        async cleanup(now) {await db.batch([
            db.prepare("DELETE FROM arcade_login_challenges WHERE expires_at <= ?").bind(now),
            db.prepare("DELETE FROM arcade_sessions WHERE expires_at <= ?").bind(now),
            db.prepare("DELETE FROM arcade_auth_limits WHERE expires_at <= ?").bind(now),
        ]);},
    };
}
