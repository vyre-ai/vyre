// Kits' calls on the real box (flows.kit.list, flows.kit.remove), over an injected `call`. Removing takes the Kit's definitions away and never a record.
import type { KitRow } from "./kits-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function kitsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    list: async (): Promise<KitRow[]> => { const r = await ask<KitRow[]>("flows.kit.list"); return Array.isArray(r) ? r : []; },
    remove: (id: string) => ask<unknown>("flows.kit.remove", { id }),
  };
}
