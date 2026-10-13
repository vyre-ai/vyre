// The agent page's four parts on the real box, over an injected `call`. Credentials never pass through here: an API token is added by the AI accounts screen, which puts it in the Vault, and this page only orders the accounts.
import type { Call } from "../settings/real-source";
import { accountsOf } from "../settings/accounts-model.ts";
import { stepsOf, type ContextFile, type Doc, type Entry, type Step } from "./config-model.ts";

export function configSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    /** Both instruction files: { "AGENTS.md": text, "CLAUDE.md": text }. */
    docs: async (agent: string): Promise<Record<Doc, string>> => {
      const d = await ask<any>("agents.docs.get", { agent });
      return { "AGENTS.md": String(d?.files?.["AGENTS.md"] ?? ""), "CLAUDE.md": String(d?.files?.["CLAUDE.md"] ?? "") };
    },
    saveDoc: (agent: string, file: Doc, text: string) => ask("agents.docs.set", { agent, file, text }),
    context: async (agent: string): Promise<{ files: ContextFile[]; links: string[] }> => {
      const d = await ask<any>("agents.context.list", { agent });
      return { files: Array.isArray(d?.files) ? d.files : [], links: Array.isArray(d?.links) ? d.links.map(String) : [] };
    },
    addContext: (agent: string, name: string, base64: string) => ask("agents.context.add", { agent, name, base64 }),
    removeContext: (agent: string, name: string) => ask("agents.context.remove", { agent, name }),
    link: (agent: string, path: string) => ask("agents.context.link", { agent, path }),
    unlink: (agent: string, path: string) => ask("agents.context.unlink", { agent, path }),
    /** The fallback plan for this agent, in the order it is tried, and every account that could join it. */
    plan: async (agent: string): Promise<{ steps: Step[]; entries: Entry[]; accounts: ReturnType<typeof accountsOf> }> => {
      const [routes, list] = await Promise.all([ask<any>("sessions.routes.get", { scope: `agent:${agent}` }), ask<any>("sessions.accounts.list")]);
      const accounts = accountsOf(list);
      const steps = stepsOf(routes, accounts);
      return { steps, entries: steps.map((s) => ({ provider: s.provider, ...(s.account ? { account: s.account } : {}) })), accounts };
    },
    savePlan: (agent: string, entries: Entry[], acknowledge = false) => ask("sessions.routes.set", { scope: `agent:${agent}`, entries, ...(acknowledge ? { acknowledge: true } : {}) }),
    vault: async (agent: string): Promise<{ assigned: string[]; items: { name: string; kind: string }[] }> => {
      const d = await ask<any>("agents.vault.list", { agent });
      return { assigned: Array.isArray(d?.assigned) ? d.assigned.map(String) : [], items: Array.isArray(d?.items) ? d.items : [] };
    },
    assign: (agent: string, item: string) => ask("agents.vault.assign", { agent, item }),
    unassign: (agent: string, item: string) => ask("agents.vault.unassign", { agent, item }),
    /** Folders to link, found by name (files.dirs); the box refuses any outside the Files roots. */
    folders: async (q: string): Promise<{ name: string; path: string }[]> => {
      const d = await ask<any>("files.dirs", { q: q.trim(), limit: 12 });
      return (Array.isArray(d?.dirs) ? d.dirs : []).filter((x: any) => x && typeof x.path === "string").map((x: any) => ({ name: String(x.name || x.path), path: x.path }));
    },
    /** The Vault's items as names, kinds and the sites a login is for. Never a value. */
    vaultItems: async (): Promise<{ name: string; kind: string; hosts: string[] }[]> => {
      const d = await ask<any>("vault.list");
      return (Array.isArray(d?.items) ? d.items : []).filter((x: any) => x && typeof x.name === "string").map((x: any) => ({ name: x.name, kind: String(x.kind || ""), hosts: Array.isArray(x.hosts) ? x.hosts.map(String) : [] }));
    },
    /** The logins lent to this agent now (vault.agent.grants): the vault's own grant, bound to one site. */
    lent: async (agent: string): Promise<{ id: string; item: string; origin: string; expires: number | null }[]> => {
      const d = await ask<any>("vault.agent.grants", { agent });
      return (Array.isArray(d?.grants) ? d.grants : []).filter((g: any) => g && g.status === "active").map((g: any) => ({ id: String(g.id), item: String(g.item), origin: String(g.origin), expires: typeof g.expires === "number" ? g.expires : null }));
    },
    /** Lend a login to the agent for one site, for 30 days. The vault asks the person's own proof; the answer may be a request that waits for their yes. */
    lend: (agent: string, item: string, origin: string) => ask<any>("vault.agent.grant", { agent, item, origin, expires: "30d" }),
    takeBack: (id: string) => ask("vault.agent.revoke", { id }),
    used: (agent: string) => ask<any>("agents.used", { agent }),
  };
}
