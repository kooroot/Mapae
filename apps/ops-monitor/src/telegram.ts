/**
 * Telegram Bot API over plain fetch. The bot token is part of the request *path*, so
 * nothing here may let a URL or a raw fetch error escape: the sender reports a boolean
 * and the caller logs a fixed string.
 */
import type {Fetcher} from "./probes";

export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * `html` is for the reports, whose every value is escaped by `report.ts`. Alerts stay plain
 * text, so probe names and collector details need no escaping. Plain text is truncated to
 * fit; HTML is refused instead, because a cut can split a tag and Telegram rejects that.
 */
export async function sendTelegram(fetcher: Fetcher, token: string, chatId: string, text: string, html = false): Promise<boolean> {
    if (html && text.length > TELEGRAM_MESSAGE_LIMIT) return false;
    const body = text.length > TELEGRAM_MESSAGE_LIMIT ? `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 1)}…` : text;
    try {
        const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({chat_id: chatId, text: body, ...(html ? {parse_mode: "HTML"} : {}), link_preview_options: {is_disabled: true}}),
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
            await response.body?.cancel();
            return false;
        }
        const value: unknown = await response.json();
        return !!value && typeof value === "object" && "ok" in value && value.ok === true;
    } catch {
        return false;
    }
}

export type BotCommand = "status" | "report" | "help";
const COMMANDS: readonly BotCommand[] = ["status", "report", "help"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The command in a webhook update, or null when the update is not a command from the one
 * allowed chat. Anything else — another chat, a group the bot was added to, an edit, a
 * sticker — is dropped without a reply, so the bot gives a stranger nothing to probe.
 */
export function parseCommand(update: unknown, allowedChatId: string): BotCommand | null {
    if (!isRecord(update) || !isRecord(update.message)) return null;
    const {chat, text} = update.message;
    if (!isRecord(chat) || (typeof chat.id !== "number" && typeof chat.id !== "string") || String(chat.id) !== allowedChatId) return null;
    if (typeof text !== "string") return null;
    // `/status@MapaeOpsBot` is how Telegram addresses a command in a group.
    const command = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/.exec(text.trim())?.[1];
    return COMMANDS.find(c => c === command) ?? null;
}
