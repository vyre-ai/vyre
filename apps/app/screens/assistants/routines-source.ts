// An agent's Routines and Watchers on the real box, over an injected `call`: its own (watchers.list with agent) and its duties (team.duties.list), as one list.
// The last answer per agent is kept, so the panel and the page draw at once and refresh behind.
import type { Call } from "../settings/real-source";
import { actCall, routineRows, type Act, type Row } from "./routines-model.js";

const last = new Map<string, Row[]>();

export function routinesSource(call: Call) {
  return {
    /** The list as last seen for this agent, or null the first time. */
    cached: (agent: string): Row[] | null => last.get(agent) ?? null,
    list: async (agent: string): Promise<Row[]> => {
      const [w, d, me] = await Promise.all([
        call<any>("watchers.list", { agent }),
        // a duty is a teammate's: a box without teammates answers an error, and the list is just the agent's own
        call<any>("team.duties.list", { teammate: agent }),
        call<any>("spaces.identity.status", {}),
      ]);
      if (w.error) throw Object.assign(new Error(w.error.message || "The list did not load."), { code: w.error.code });
      const rows = routineRows(w.data, d.error ? null : d.data, me.error ? null : (me.data && typeof me.data.id === "string" ? me.data.id : null));
      last.set(agent, rows);
      return rows;
    },
    act: async (r: Row, act: Act): Promise<void> => {
      const c = actCall(r, act);
      const out = await call(c.tool, c.input);
      if (out.error) throw Object.assign(new Error(out.error.message || "That did not go through."), { code: out.error.code });
    },
  };
}
