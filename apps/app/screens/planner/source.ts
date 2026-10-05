// The planner's calls on the real box, over an injected `call`.
import type { Call } from "../settings/real-source";
import { agendaOf, ringingOf, type Item, type Ringing } from "./model.ts";

export function plannerSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    agenda: async () => agendaOf(await ask("planner.agenda")),
    open: async (): Promise<Item[]> => { const d = await ask<any>("planner.list", { state: "open", limit: 200 }); return Array.isArray(d) ? d : []; },
    /** The box reads the words into a proposed item; null when it cannot place them. */
    parse: (text: string, kind?: string) => ask<any>("planner.parse", { text, ...(kind ? { kind } : {}) }),
    add: (input: { text: string; kind?: string }) => ask("planner.add", input),
    done: (item: string) => ask("planner.done", { item }),
    reopen: (item: string) => ask("planner.update", { item, state: "open" }),
    remove: (item: string) => ask("planner.delete", { item }),
    restore: (item: string) => ask("planner.delete", { item, restore: true }),
    /** A ringing firing: Done stops it, Snooze rings it again later. */
    answer: (tool: "planner.done" | "planner.snooze", firing: string) => ask(tool, { firing }),
    ringing: async (): Promise<Ringing[]> => { const d = await ask<any>("planner.ringing"); return (Array.isArray(d) ? d : []).map(ringingOf).filter((x): x is Ringing => !!x); },
  };
}
