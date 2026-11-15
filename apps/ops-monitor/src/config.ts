/**
 * Worker secrets, validated once per invocation. A missing or malformed secret is
 * reported by *name* only, never by value; the monitor refuses to run half-configured
 * because a probe silently skipped for want of a token is a monitor that lies.
 */
import {INGEST_TOKEN_PATTERN} from "@mapae/shared/ops-ingest";
import type {MetricsKeys} from "./probes";
import type {D1Like} from "./store";

export interface Env {
    DB: D1Like;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_CHAT_ID?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    INGEST_TOKEN?: string;
    SELLER_METRICS_TOKEN?: string;
    FACILITATOR_METRICS_TOKEN?: string;
}

export interface Config {
    botToken: string;
    chatId: string;
    webhookSecret: string;
    ingestToken: string;
    metricsKeys: MetricsKeys;
}

export class ConfigError extends Error {
    readonly _tag = "ConfigError";
    constructor(readonly variable: keyof Env) {
        super(`config_invalid: ${variable}`);
    }
}

function read(env: Env, name: Exclude<keyof Env, "DB">, pattern: RegExp): string {
    const value = env[name];
    if (typeof value !== "string" || !pattern.test(value)) throw new ConfigError(name);
    return value;
}

export function parseConfig(env: Env): Config {
    return {
        // BotFather's shape: numeric bot id, colon, 35-ish URL-safe characters.
        botToken: read(env, "TELEGRAM_BOT_TOKEN", /^\d{5,20}:[A-Za-z0-9_-]{30,64}$/),
        // A private chat is a positive id; a group or channel is negative.
        chatId: read(env, "TELEGRAM_CHAT_ID", /^-?\d{1,20}$/),
        // Telegram's own constraint for `secret_token`; 32 is our floor, not theirs.
        webhookSecret: read(env, "TELEGRAM_WEBHOOK_SECRET", /^[A-Za-z0-9_-]{32,256}$/),
        ingestToken: read(env, "INGEST_TOKEN", INGEST_TOKEN_PATTERN),
        metricsKeys: {
            seller: read(env, "SELLER_METRICS_TOKEN", /^[\x21-\x7e]{16,256}$/),
            facilitator: read(env, "FACILITATOR_METRICS_TOKEN", /^[\x21-\x7e]{16,256}$/),
        },
    };
}
