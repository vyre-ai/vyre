// AI accounts' calls on the real box (sessions.accounts.*), over an injected `call`. Nothing here reads a token: a login's secret is written by the provider's own command into that account's own folder.
import type { Call } from "./real-source";
import { accountsOf, flowOf, keyAddInput, type Account, type Flow } from "./accounts-model.ts";

export function accountsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    list: async (): Promise<Account[]> => accountsOf(await ask("sessions.accounts.list")),
    /** Start a sign-in (a provider and an optional name), or sign an existing account in again. */
    start: async (provider: string, label = "", account = ""): Promise<Flow> =>
      flowOf(await ask("sessions.accounts.signin", { provider, ...(label ? { label } : {}), ...(account ? { account } : {}) }), provider),
    /** One status call on a flow; the box holds it open for a while. */
    follow: async (flow: string, provider: string): Promise<Flow> => flowOf(await ask("sessions.accounts.signin", { flow }), provider, flow),
    /** The code the provider's page showed. */
    paste: (flow: string, code: string) => ask("sessions.accounts.signin", { flow, code: code.trim() }),
    /** An API key as an account: the owner's goes to the server's key tool and the owner's Vault; a member's goes to HER OWN Vault through the member key path (the host's onboard.agent.key, which may ask for
     * her Vault's password: code need_password) and becomes an account of hers alone. Only the account comes back. Throws the line to show when the key is not one. */
    addKey: (key: string, label = "", member: { password?: string } | null = null) => {
      const k = keyAddInput(key, label);
      if ("problem" in k) return Promise.reject(new Error(k.problem));
      const own: Record<string, string> = { ...k.input }; delete own.name;   // the member path names the item from the label
      // whatever the server or the provider said, the key is never in what is thrown
      return (member ? ask<{ account?: string; provider?: string; label?: string }>("onboard.agent.key", { ...own, ...(member.password ? { password: member.password } : {}) }) : ask<{ account?: string; provider?: string; label?: string }>("sessions.accounts.key", k.input))
        .catch((e) => { throw Object.assign(new Error(String((e as Error)?.message || "That key could not be added.").split(k.input.key).join("[key]")), { code: (e as { code?: string })?.code }); });
    },
    makeDefault: (id: string) => ask("sessions.accounts.bind", { id, is_default: true }),
    remove: (id: string) => ask("sessions.accounts.remove", { id }),
    /** A Grok account's privacy mode, as the person says they set it on the provider's side. */
    setPrivacy: (account: string, privacy: boolean) => ask("sessions.accounts.set", { account, privacy }),
  };
}
