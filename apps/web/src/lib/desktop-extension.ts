import type {Hex} from "viem";
import type {SessionGrant} from "./grant";

/**
 * The Claude Desktop path (ENG-6): one archive to double-click and two values to paste.
 *
 * The archive is `bun run build:mcpb` output (`apps/agent-mcp/mcpb/pack.ts`), copied
 * byte-identical to `apps/web/public/mapae.mcpb` (gitignored) so Vite places it in the
 * app surface's build output; `public/_headers` serves it as an attachment.
 */
export const DESKTOP_EXTENSION_PATH = "/mapae.mcpb";
export const DESKTOP_EXTENSION_FILENAME = "mapae.mcpb";

export type DesktopPasteValues = {
    /** Exactly the 0x-prefixed 32-byte hex — the Desktop dialog's "agent key" field. */
    agentPrivateKey: Hex | undefined;
    /** Exactly the permission code — the Desktop dialog's "permission code" field. */
    permissionContext: Hex;
};

/**
 * The two values the Desktop install dialog asks for. `agentPrivateKey` is undefined when
 * this tab no longer holds the key (imported or recovered grants): it is never stored.
 */
export function desktopPasteValues(grant: Pick<SessionGrant, "agentKey" | "artifact">): DesktopPasteValues {
    const key = grant.agentKey?.privateKey;
    return {
        agentPrivateKey: key && /^0x[0-9a-fA-F]{64}$/.test(key) ? key : undefined,
        permissionContext: grant.artifact.permissionContext,
    };
}
