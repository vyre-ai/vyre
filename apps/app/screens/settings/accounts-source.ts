// AI accounts' calls on the real box (sessions.accounts.*), over an injected `call`. Nothing here reads a token: a login's secret is written by the provider's own command into that account's own folder,
// and a key goes once to the server's key tool (or, to replace one, to the Vault item the account already names) and is never kept or returned.
import type { Call } from "./real-source";
import { accountsOf, flowOf, keyInputFor, routeEntries, type Account, type Flow, type RouteEntry } from "./accounts-model.ts";

export function accountsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  /** A refusal never carries the key it was about, whatever the server or the provider said. */
  const scrub = (key: string) => (e: unknown) => { throw Object.assign(new Error(String((e as Error)?.message || "That key could not be added.").split(key).join("[key]")), { code: (e as { code?: string })?.code }); };
  return {
    /** Every account the person has, on every provider: the one list every row of AI accounts reads. */
    list: async (): Promise<Account[]> => accountsOf(await ask("sessions.accounts.list")),
    /** Start a sign-in (a provider and an optional name), or sign an existing account in again. */
    start: async (provider: string, label = "", account = ""): Promise<Flow> =>
      flowOf(await ask("sessions.accounts.signin", { provider, ...(label ? { label } : {}), ...(account ? { account } : {}) }), provider),
    /** One status call on a flow; the box holds it open for a while. */
    follow: async (flow: string, provider: string): Promise<Flow> => flowOf(await ask("sessions.accounts.signin", { flow }), provider, flow),
    /** The code the provider's page showed. */
    paste: (flow: string, code: string) => ask("sessions.accounts.signin", { flow, code: code.trim() }),
    /** An API key as an account under one provider (the owner's): the server checks it with the provider and keeps it in the Vault; only the account comes back. Throws the line to show when the key is not one. */
    addKey: (provider: string, key: string, label = "", baseUrl = "", member: { password?: string } | null = null) => {
      const k = keyInputFor(provider, key, label, baseUrl);
      if ("problem" in k) return Promise.reject(new Error(k.problem));
      // a member's key goes to HER OWN Vault through the member key path (the host's onboard.agent.key, which may ask for her Vault's password: code need_password), never the owner's key tool
      if (member) { const own: Record<string, string> = { ...k.input }; delete own.name; return ask<{ account?: string; provider?: string; label?: string }>("onboard.agent.key", { ...own, ...(member.password ? { password: member.password } : {}) }).catch(scrub(k.input.key)); }
      return ask<{ account?: string; provider?: string; label?: string }>("sessions.accounts.key", k.input).catch(scrub(k.input.key));
    },
    /** A new key for an API-key account: checked with the provider first (nothing kept), then put in place of the old one in the Vault item the account names, so the account and every order that names it stay. */
    replaceKey: async (a: Account, key: string) => {
      const k = keyInputFor(a.provider, key, a.label, a.baseUrl ?? "");
      if ("problem" in k) throw new Error(k.problem);
      if (!a.item) throw new Error("This account has no key in your Vault to replace. Remove it and add the key again.");
      await ask("sessions.accounts.key", { kind: k.input.kind, key: k.input.key, check_only: true, ...(a.provider === "opencode" ? { account: a.id } : {}), ...(k.input.base_url ? { base_url: k.input.base_url } : {}) }).catch(scrub(k.input.key));
      const items = await ask<{ items?: { name?: string; kind?: string; description?: string; hosts?: string[] }[] }>("vault.list");
      const was = (items?.items ?? []).find((x) => x && x.name === a.item);
      await ask("vault.put", { name: a.item, kind: was?.kind || "api-key", ...(was?.description ? { description: was.description } : {}), value: k.input.key, ...(was?.hosts?.length ? { hosts: was.hosts } : {}) }).catch(scrub(k.input.key));
    },
    makeDefault: (id: string) => ask("sessions.accounts.bind", { id, is_default: true }),
    remove: (id: string) => ask("sessions.accounts.remove", { id }),
    /** A Grok account's privacy mode, as the person says they set it on the provider's side. */
    setPrivacy: (account: string, privacy: boolean) => ask("sessions.accounts.set", { account, privacy }),
    /** OpenCode only. True uses Go models only when this key listed them. False uses the regular models. */
    setGo: (account: string, goOnly: boolean) => ask("sessions.accounts.set", { account, go_only: goOnly }),
    /** The Assistant and the order of accounts it runs on (its own fallback order), or null when there is no Assistant. */
    assistant: async (): Promise<{ name: string; entries: RouteEntry[] } | null> => {
      const list = await ask<any[]>("agents.list");
      const a = (Array.isArray(list) ? list : []).find((x) => x && x.kind === "assistant" && typeof x.name === "string");
      if (!a) return null;
      return { name: String(a.name), entries: routeEntries(await ask("sessions.routes.get", { scope: `agent:${a.name}` })) };
    },
    /** Save the Assistant's order. */
    setAssistant: (name: string, entries: RouteEntry[]) => ask("sessions.routes.set", { scope: `agent:${name}`, entries }),
  };
}
