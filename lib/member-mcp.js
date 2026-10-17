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

/**
 * What a session's own MCP config holds of a member's servers: nothing. A member's servers are rows of the hub, reached through the one `vyre` entry, where the token is added per call after a grant check; a
 * harness never holds an upstream address, a header or a token. The store entries older builds kept here are moved into rows (legacyRows) and then removed.
 * @param {Parameters<typeof memberServers>[0]} _store
 */
export async function memberMcpConfig(_store) { return { mcpServers: {} }; }

/**
 * The older store entries as hub rows. A bearer token in an authorization header becomes `token` (the caller makes the connection item for it); an entry with no header is a plain row; an entry with any other
 * header is left where it is. @param {{ name: string, type: string, url: string, headers?: Record<string, string> }[]} entries
 * @returns {{ rows: { row: { name: string, transport: string, url: string }, token?: string }[], left: { name: string }[] }}
 */
export function legacyRows(entries) {
  const rows = [], left = [];
  for (const e of entries) {
    const row = { name: e.name, transport: e.type, url: e.url };
    const h = e.headers && typeof e.headers === "object" ? Object.entries(e.headers) : [];
    if (!h.length) { rows.push({ row }); continue; }
    const m = h.length === 1 && h[0][0].toLowerCase() === "authorization" ? /^Bearer\s+(\S+)$/.exec(String(h[0][1])) : null;
    if (m) rows.push({ row, token: m[1] }); else left.push({ name: e.name });
  }
  return { rows, left };
}
export { mergeMcpServers } from "./merge-mcp.js";

/**
 * A personal-store-shaped backend over tool calls for the caller's own person (vault.me.store.*, which resolve the person from the call's chain, never from the input).
 * @param {(tool: string, input: any) => Promise<{ data?: any, error?: { message: string, code?: string } }>} call
 */
export function storeOverCalls(call) {
  // Literal tool names at each call site (the reach tests read them): the answer is checked by one helper.
  const ok = r => { if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code || "failed" }); return r ? r.data : undefined; };
  return {
    get: async k => { const d = ok(await call("vault.me.store.get", { key: k })); return d === undefined ? null : d; },
    put: async (k, v) => { ok(await call("vault.me.store.put", { key: k, value: v })); },
    list: async () => { const d = ok(await call("vault.me.store.list", {})); return Array.isArray(d) ? d : []; },
    remove: async k => { const d = ok(await call("vault.me.store.remove", { key: k })); return Boolean(d && d.removed === true); },
  };
}
