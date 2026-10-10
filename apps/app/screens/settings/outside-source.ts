// Outside agents' calls on the real box (outside.*, records.types, work.project...), over an injected `call`. A token comes back once, from outside.register or outside.token, and is never read again.
import type { Call } from "./real-source";
import { agentsOf, typesOf, type Agent, type RecordType, type Registered } from "./outside-model.ts";

export function outsideSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    list: async (): Promise<Agent[]> => agentsOf(await ask("outside.list")),
    types: async (): Promise<RecordType[]> => typesOf(await ask("records.types")),
    register: (name: string, note = ""): Promise<Registered> => ask("outside.register", { name, ...(note ? { note } : {}) }),
    token: (id: string): Promise<Registered> => ask("outside.token", { id }),
    grant: (id: string, what: Record<string, unknown>) => ask("outside.grant", { id, what }),
    ungrant: (id: string, grant: string) => ask("outside.ungrant", { id, grant }),
    revoke: (id: string) => ask("outside.revoke", { id }),
  };
}
