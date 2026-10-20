// Webhook routes on the real vyred, over the one tool call (watchers belong to agents now: screens/assistants/AgentRoutines). The owner's door: a member gets the box's refusal in words, never a widened list.
import { callT } from "../../src/real/call-tool";

async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
  const r = await callT<T>(tool, input);
  if (r.error) throw Object.assign(new Error(r.error.message || r.error.code || "That did not go through."), { code: r.error.code });
  return r.data as T;
}

export type HookRoute = { name: string; path?: string; scheme?: string; header?: string; secret?: string; deliveries?: number };
export type HooksState = { enabled: boolean; listening: boolean; routes: HookRoute[]; public: { available: boolean; base?: string; why?: string }; urls: Record<string, string | null> };

export const hooksSource = {
  /** The listener, the open routes and whether the internet can reach them. A box without webhooks gives null. */
  state: async (): Promise<HooksState | null> => {
    try {
      const [list, status] = await Promise.all([ask<any>("hooks.list", {}), ask<any>("hooks.status", {})]);
      const routes: HookRoute[] = (Array.isArray(list?.routes) ? list.routes : []).map((r: any) => ({ name: String(r.name ?? r.route ?? ""), path: r.path ?? `/hooks/${r.name}`, scheme: r.verify?.scheme ?? r.scheme, header: r.verify?.header ?? r.header, secret: r.verify?.secret ?? r.secret, deliveries: r.deliveries }));
      return { enabled: !!(status?.enabled ?? list?.enabled), listening: !!status?.listening, routes: routes.filter((r) => r.name), public: status?.public ?? { available: false }, urls: status?.urls ?? {} };
    } catch { return null; }
  },
  enable: (on: boolean) => ask<any>("hooks.enable", { on }),
  /** With no secret named, the box makes one in the Vault as hooks-<name> and grants it to the webhooks module; its value is never in the answer. */
  open: (name: string, scheme: string, header: string, secret: string) => ask<any>("hooks.open", { name, scheme, ...(header.trim() ? { header: header.trim() } : {}), ...(secret.trim() ? { secret: secret.trim() } : {}) }),
  close: (name: string) => ask<any>("hooks.close", { name }),
};
