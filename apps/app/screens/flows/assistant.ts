import { call } from "../../src/api/box";
import { assistantSource } from "./assistant-source";

export const { agents: listAgents, role: myRole, create: createEngineer, say: sayToEngineer, flows: listFlowRows, kits: listKitRows } = assistantSource(call);
