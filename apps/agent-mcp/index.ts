import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {loadDelegatedAgentRuntime} from "@mapae/delegation";
import {createAgentServer} from "./server.js";

const server = createAgentServer(() => loadDelegatedAgentRuntime());

// stdout is the JSON-RPC channel; anything written there corrupts the stream.
console.error("mapae agent MCP server running on stdio");
await server.connect(new StdioServerTransport());
