// Connections' calls on a real vyred, over an injected `call` (the app's box connection, or a fake box in a test): connectors.* (the catalog and its sign-in steps), mcp.*, google.*,
// github.*, vault.connections.* and vault.list / vault.grant (a server's or account's vault item must be readable by its module). Acts that need the person are answered by the app's
// call with the device's own proof. A token typed here goes to the box once and is not kept; a refusal's text never echoes it (model.ts redact).
import { pickMade, pickProposals, toCreate, type FormInput } from "./any-app.ts";
import { deviceFlow, groupsOf, pickAccounts, pickConnections, pickGithub, pickGoogleTest, pickItems, pickRepos, pickServers, pickTest, stepOf, type Scope } from "./model.ts";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function connectionsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    // the catalog
    async catalog() { return groupsOf(await ask("connectors.catalog", {})); },
    /** One step of a connect. The scope is sent only when the person chose one (the default writes nothing). */
    async connect(preset: string, label: string, o: { scope?: Scope; token?: string; extra?: Record<string, string>; client?: string; app?: { client_id: string; client_secret?: string } } = {}) {
      return stepOf(await ask("connectors.connect", { preset, ...(o.scope ? { scope: o.scope } : {}), ...(o.token ? { token: o.token } : {}), ...(o.extra && Object.keys(o.extra).length ? { extra: o.extra } : {}), ...(o.client ? { client: o.client } : {}), ...(o.app ? { app: o.app } : {}) }), label);
    },
    connectCancel: (id: string) => ask("connectors.connect.cancel", { id }),
    /** Finish a sign-in with the whole address the browser landed on (a browser on another device). */
    connectFinish: (id: string, url: string) => ask("connectors.connect.finish", { id, url }),
    disconnect: (name: string) => ask("connectors.disconnect", { name }),
    /** Who can use a connection that exists; a null scope is the default. */
    setScope: (name: string, scope: Scope) => ask("connectors.scope", { name, scope }),
    // MCP servers
    async servers() { return pickServers(await ask("mcp.servers")); },
    async addServer(input: Record<string, unknown>) { const r = await ask<{ test?: unknown }>("mcp.add", input); return { test: r?.test ? pickTest(r.test) : null }; },
    async testServer(name: string) { return pickTest(await ask("mcp.test", { name })); },
    restartServer: (name: string) => ask("mcp.restart", { name }),
    removeServer: (name: string) => ask("mcp.remove", { name }),
    /** Set what each tool may do: the whole policy goes back with the new modes. */
    setPolicy: (name: string, policy: Record<string, unknown>) => ask("mcp.update", { name, tools: policy }),
    // Google accounts
    async accounts() { return pickAccounts(await ask("google.accounts")); },
    addAccount: (input: Record<string, unknown>) => ask("google.add", input),
    async testAccount(name: string) { return pickGoogleTest(await ask("google.test", { name })); },
    removeAccount: (name: string) => ask("google.remove", { name }),
    /** Start "Sign in with Google": the address to open, never a secret (a client id and a PKCE challenge). */
    async googleConnect(name: string, client: string): Promise<{ id: string; url: string }> {
      const r = await ask<{ id?: string; url?: string }>("google.connect", { name, client });
      if (!r?.id || !/^https:\/\//.test(String(r.url))) throw Object.assign(new Error("Vyre did not return Google's address. Try again."), { code: "bad_answer" });
      return { id: r.id, url: String(r.url) };
    },
    googleCancel: (id: string) => ask("google.connect.cancel", { id }),
    async googleFinish(id: string, url: string): Promise<{ name: string; email: string }> {
      const r = await ask<{ name?: string; email?: string }>("google.connect.finish", { id, url });
      return { name: String(r?.name ?? ""), email: String(r?.email ?? "") };
    },
    // GitHub
    async githubAccounts() { return pickGithub(await ask("github.accounts", {})); },
    /** Start the device sign-in: a short code and GitHub's own page. */
    async githubDevice(name: string) { const f = deviceFlow(await ask("github.connect", { name })); if (!f) throw Object.assign(new Error("GitHub did not return a code. Try again."), { code: "bad_answer" }); return f; },
    /** The other way in: a token the person made at GitHub. Sent once; the answer names the login and how many repos it reaches. */
    async githubToken(name: string, token: string): Promise<{ login: string; repos: number | null }> {
      const r = await ask<{ login?: string; repos?: number }>("github.connect", { name, token });
      return { login: String(r?.login ?? ""), repos: typeof r?.repos === "number" ? r.repos : null };
    },
    githubCancel: (id: string) => ask("github.connect.cancel", { id }),
    /** Removes Vyre's own vault item and account row; it never revokes the token at GitHub. */
    githubRemove: (name: string) => ask("github.remove", { name }),
    async githubRepos(o: { account?: string; q?: string; page?: number }) { return pickRepos(await ask("github.repos", { ...(o.account ? { account: o.account } : {}), ...(o.q ? { q: o.q } : {}), page: o.page ?? 1, limit: 30 })); },
    // any app with an API: the person's own Connections (connectors.connection.*)
    async madeList() { return pickMade(await ask("connectors.connection.list", {})); },
    /** Make the Connection and run its check once; the answer is the light in words. */
    async madeCreate(f: FormInput) {
      const made = await ask<{ id: string }>("connectors.connection.create", toCreate(f));
      const chk = await ask<{ light: string; words: string }>("connectors.connection.check", { id: made.id });
      return { id: made.id, light: chk.light, words: chk.words };
    },
    async madeProposals() { return pickProposals(await ask("connectors.connection.proposals", {})); },
    madeApprove: (proposal: string) => ask("connectors.connection.approve", { proposal }),
    madeDecline: (proposal: string) => ask("connectors.connection.decline", { proposal }),
    madeCheck: (id: string) => ask<{ light: string; words: string }>("connectors.connection.check", { id }),
    madeDelete: (id: string) => ask("connectors.connection.delete", { id }),
    // vault: items, grants, connections by surface
    async vaultItems() { return pickItems(await ask("vault.list", {})); },
    /** Let a module read a vault item: a person's own act (the box asks for presence). */
    grantItem: (name: string, module: string) => ask("vault.grant", { name, module }),
    async connections() { return pickConnections(await ask("vault.connections.list", {})); },
    grantSurface: (id: string, surface: string) => ask("vault.connections.grant", { id, surface }),
    revokeSurface: (id: string, surface: string) => ask("vault.connections.revoke", { id, surface }),
    async projects(): Promise<{ slug: string; name: string }[]> {
      const r = await ask<{ projects?: { slug?: string; name?: string }[] } | { slug?: string; name?: string }[]>("projects.list", {});
      const l = Array.isArray(r) ? r : r?.projects ?? [];
      return l.filter((x) => x && x.slug).map((x) => ({ slug: String(x.slug), name: String(x.name || x.slug) }));
    },
  };
}
