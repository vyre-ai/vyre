// @ts-check
// member-store: the MCP servers a team member brought themselves (owner decision 00:57Z, routes a and b). A thin adapter onto the member's
// personal store (personalStore(person, space) from the vault: async get/put/list/remove of JSON under a key, sealed under the member's own
// password), so there is one place per-person secrets live. The owner's vault, the owner's calls and other members never reach it.
// Only REMOTE servers (http or sse over https to a public host) are kept: a stdio entry would run a command on the member's computer on the
// word of whatever filled the store, so it is refused at put and dropped at read.

const PREFIX = "mcp/";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const bad = m => Object.assign(new Error(m), { code: "bad_input" });

/** Whether a stored entry is a remote https server on a named public host. @param {any} d */
export function remoteOk(d) {
  if (!d || typeof d !== "object" || (d.type !== "http" && d.type !== "sse")) return false;
  let u;
  try { u = new URL(String(d.url)); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return false;
  return true;
}

/** @param {{ get(k: string): Promise<any>, put(k: string, v: any): Promise<void>, list(): Promise<{ key: string, value: any }[]>, remove(k: string): Promise<boolean> }} store one person's personalStore */
export function memberServers(store) {
  return {
    /** @returns {Promise<{ name: string, [k: string]: any }[]>} */
    async list() { return (await store.list()).filter(e => e.key.startsWith(PREFIX) && NAME.test(e.key.slice(PREFIX.length)) && e.key.slice(PREFIX.length) !== "vyre" && remoteOk(e.value)).map(e => ({ name: e.key.slice(PREFIX.length), ...e.value })); },
    async get(name) { const v = await store.get(PREFIX + name); return remoteOk(v) ? v : null; },
    async put(name, def) {
      if (!NAME.test(String(name))) throw bad("name must be letters, digits, dot, dash");
      if (name === "vyre") throw bad("vyre is reserved for Vyre's own tools");
      if (!def || typeof def !== "object" || (def.type !== "http" && def.type !== "sse")) throw bad("a server you bring is a remote one: type http or sse with an https url");
      if (!remoteOk(def)) throw bad("the url must be https to a public host");
      await store.put(PREFIX + name, def);
    },
    remove: name => store.remove(PREFIX + name),
  };
}

/** A `--mcp-config` object for one member's own servers. A locked or unreadable store gives none, so the session still starts. @param {Parameters<typeof memberServers>[0]} store */
export async function memberMcpConfig(store) {
  /** @type {Record<string, any>} */ const mcpServers = {};
  try { for (const { name, ...def } of await memberServers(store).list()) mcpServers[name] = def; } catch { /* locked: no member servers this time */ }
  return { mcpServers };
}
export { mergeMcpServers } from "./merge-mcp.js";

/**
 * A personal-store-shaped backend over tool calls for the caller's own person (vault.me.store.*, which resolve the person from the call's chain, never from the input).
 * @param {(tool: string, input: any) => Promise<{ data?: any, error?: { message: string, code?: string } }>} call
 */
export function storeOverCalls(call) {
  const run = async (tool, input) => { const r = await call(tool, input); if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" }); return r ? r.data : undefined; };
  return {
    get: async k => { const d = await run("vault.me.store.get", { key: k }); return d === undefined ? null : d.value ?? null; },
    put: async (k, v) => { await run("vault.me.store.put", { key: k, value: v }); },
    list: async () => { const d = await run("vault.me.store.list", {}); return Array.isArray(d) ? d : (d && d.entries) || []; },
    remove: async k => { const d = await run("vault.me.store.remove", { key: k }); return d === true || (d && d.removed === true); },
  };
}
