// @ts-check
// `vyre mcp design` starts here: the Design and Module MCP on stdio (design.js holds the tools, so tests can import them without a server).
import { serve } from "./design.js";

await serve();
