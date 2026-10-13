import { callT as call } from "../../src/real/call-tool";
import { mcpSource } from "./mcp-source";

export const mcp = mcpSource(call);
