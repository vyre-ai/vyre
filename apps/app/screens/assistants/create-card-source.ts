// What the Create your assistant card needs from the box, over an injected `call`.
import type { Call } from "../settings/real-source";
import { agentsOf, type AgentRow } from "./create-card-model.ts";

export function createCardSource(call: Call) {
  return {
    /** null when the box does not answer: the card stays away rather than guess. */
    agents: async (): Promise<AgentRow[] | null> => { const r = await call<unknown>("agents.list"); return r.error ? null : agentsOf(r.data); },
  };
}
