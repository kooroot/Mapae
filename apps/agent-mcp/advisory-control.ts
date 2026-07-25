/**
 * Not part of the MCP server. Nothing imports this, and it must stay that way.
 *
 * `scripts/check-advisories.ts` accepts one dependency advisory on the grounds that the
 * vulnerable HTTP adapter never enters our bundle, and it measures that by bundling
 * `index.ts` and finding zero references. A detector that always returns zero would pass
 * that check while proving nothing — a silent fail-open in a security gate.
 *
 * This file is the control: it deliberately imports the transport the real server does
 * not, so the gate can confirm the detector still finds a reference when one exists
 * before trusting the absence of one. It lives here rather than beside the gate because
 * `@modelcontextprotocol/sdk` resolves through this package's own `node_modules` and not
 * from the repository root.
 */
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const CONTROL_TRANSPORT = StreamableHTTPServerTransport;
