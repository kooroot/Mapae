/**
 * Not part of the MCP server. Nothing imports this, and it must stay that way.
 *
 * `scripts/check-mcp-stdio.ts` holds this server to the stdio transport, and it measures
 * that by bundling `index.ts` and finding zero references to the HTTP adapter. A detector
 * that always returns zero would pass that check while proving nothing — a silent
 * fail-open in a gate whose entire output is an absence.
 *
 * This file is the control: it deliberately imports the transport the real server does
 * not, so the gate can confirm the detector still finds a reference when one exists
 * before trusting the absence of one. It lives here rather than beside the gate because
 * `@modelcontextprotocol/sdk` resolves through this package's own `node_modules` and not
 * from the repository root.
 */
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const CONTROL_TRANSPORT = StreamableHTTPServerTransport;
