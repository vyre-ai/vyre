import { callT as call } from "../../src/real/call-tool";
import { assistantSource } from "./assistant-source";

export const { agents: listAgents, role: myRole, say: sayToEngineer, flows: listFlowRows, kits: listKitRows, tasks: listTaskRows } = assistantSource(call);
