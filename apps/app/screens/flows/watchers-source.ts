// Watchers and webhook routes on the real vyred, over the one tool call. The owner's door: a member gets the box's refusal in words, never a widened list.
import { callT } from "../../src/real/call-tool";
import { projectNames } from "./real";
import type { WatcherRow } from "./watchers-model.js";

async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
  const r = await callT<T>(tool, input);
  if (r.error) throw Object.assign(new Error(r.error.message || r.error.code || "That did not go through."), { code: r.error.code });
  return r.data as T;
}

export const watchersSource = {
  list: async (): Promise<WatcherRow[]> => { const d = await ask<{ watchers?: WatcherRow[] }>("watchers.list", {}); return Array.isArray(d?.watchers) ? d.watchers : []; },
  projects: async (): Promise<[string, string][]> => Object.entries(await projectNames()),
  preset: (input: Record<string, unknown>) => ask<any>("watchers.preset", input),
  test: (name: string) => ask<any>("watchers.test", { name }),
  card: (name: string) => ask<any>("watchers.card", { name }),
  create: (name: string, hash: string) => ask<any>("watchers.create", { name, hash }),
  run: (name: string) => ask<any>("watchers.run", { name }),
  pause: (name: string) => ask<any>("watchers.pause", { name }),
  resume: (name: string) => ask<any>("watchers.resume", { name }),
  remove: (name: string) => ask<any>("watchers.delete", { name }),
};

export type FlowHookState = { open: boolean; address: { path: string; url: string | null } | null; why: string | null; last: { at?: string; when?: string; ok: boolean; why?: string; bytes: number; test?: boolean } | null; check: { scheme: string; header?: string; secret: string } | null };

/** A Flow's own webhook address (hooks.flow and its acts). The address carries its token, so it is read only here, for the person, and never kept. A server without webhooks gives null. */
export const flowHookSource = {
  state: async (flow: string): Promise<FlowHookState | null> => { try { return await ask<FlowHookState>("hooks.flow", { flow }); } catch { return null; } },
  renew: (flow: string) => ask<any>("hooks.flow.renew", { flow }),
  test: (flow: string) => ask<{ ok: boolean; line: string }>("hooks.flow.test", { flow }),
  sign: (flow: string, scheme: string, header: string, secret: string) => ask<any>("hooks.flow.sign", { flow, scheme, ...(header ? { header } : {}), ...(secret ? { secret } : {}) }),
};
