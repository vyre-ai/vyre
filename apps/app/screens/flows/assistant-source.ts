// @Engineer's calls on the real box over an injected `call`: agents.list to find the Engineer, agents.ask to send a first message (it starts the thread when there is none),
// spaces.list for the person's role, flows.list and flows.kit.list for what is waiting. The conversation itself is the app's chat on the thread (src/chat).
import type { Agent, FlowRow, KitRow, TaskRow } from "./assistant-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function assistantSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  const list = async <T,>(tool: string): Promise<T[]> => { const r = await ask<T[]>(tool); return Array.isArray(r) ? r : []; };
  return {
    agents: () => list<Agent>("agents.list"),
    /** The person's role in the first space. */
    role: async (): Promise<string> => (await list<{ role?: string }>("spaces.list"))[0]?.role ?? "member",
    /** The proposals waiting in Now: tasks.list rows (the box answers the rows bare or under `tasks`). */
    tasks: async (): Promise<TaskRow[]> => { const r = await ask<TaskRow[] | { tasks?: TaskRow[] }>("tasks.list"); return Array.isArray(r) ? r : Array.isArray(r?.tasks) ? r.tasks : []; },
    /** Send the first message. The box starts the Engineer's thread if it has none. */
    say: (agent: string, text: string) => ask<unknown>("agents.ask", { agent, text }),
    flows: () => list<FlowRow>("flows.list"),
    kits: () => list<KitRow>("flows.kit.list"),
  };
}
