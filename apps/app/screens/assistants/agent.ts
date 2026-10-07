import { callT as call } from "../../src/real/call-tool";
import { agentSource } from "./agent-source";

export const agent = agentSource(call);
