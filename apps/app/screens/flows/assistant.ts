import { call } from "../../src/api/box";
import { assistantSource } from "./assistant-source";

export const { agents: listAgents, role: myRole, say: sayToEngineer, flows: listFlowRows, kits: listKitRows, tasks: listTaskRows } = assistantSource(call);
