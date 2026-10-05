// Spend and standing permissions on the real box, over an injected `call`.
import type { Call } from "./real-source";
import { addInput, intentsOf, providersOf, capInput, type Intent, type PermissionForm, type SpendRow } from "./limits-model.ts";

export function limitsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    spend: async (): Promise<{ day: string; rows: SpendRow[] }> => { const d = await ask<any>("spend.summary"); return { day: String(d?.day || ""), rows: providersOf(d) }; },
    /** A typed cap in dollars. Throws the line to show when it is not an amount. */
    setCap: (provider: string, raw: string) => {
      const c = capInput(raw);
      if ("problem" in c) return Promise.reject(new Error(c.problem));
      return ask("spend.raise", { provider, to: c.to });
    },
    noCap: (provider: string) => ask("spend.raise", { provider, off: true }),
    permissions: async (): Promise<Intent[]> => intentsOf(await ask("gate.said.list")),
    /** Throws the line to show when the form is not complete; the box asks the person's proof itself for a payment or a blanket allow. */
    allow: (f: PermissionForm) => {
      const a = addInput(f);
      if ("problem" in a) return Promise.reject(new Error(a.problem));
      return ask("gate.said.add", a.input);
    },
    takeBack: (id: string) => ask("gate.said.revoke", { id }),
    /** The names of the person's own agents, to suggest in the form. */
    agentNames: async (): Promise<string[]> => {
      const d = await ask<any>("agents.list");
      return (Array.isArray(d) ? d : d?.agents || []).filter((x: any) => x && x.kind !== "assistant").map((x: any) => String(x.name));
    },
  };
}
