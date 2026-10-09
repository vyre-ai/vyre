// @ts-check
// core/vault/passmcp.js: the Vault MCP for outside agents (R031-77, team/0.3/DESIGN-vaults-named.md). A person makes a pass for chosen api credentials and gets an MCP address and a token for an outsider's
// agent (Claude Code, Codex). The outside agent can have a call made with the key at home and never sees it: the call runs through the same relay as `vault.request` (pinned hosts, the credential's own
// rules, a read runs, anything else is held for a person), every use is a kernel decision and an audit row, the pass expires and can be ended.
//
// A pass is kernel grants to one actor of its own (`ext_<id>`, source `vault:pass:<id>`): `vault.read` and `vault.call` on each item, until the expiry, at a rate. The token is a lookup key to the pass row,
// stored only as a hash and compared in constant time; a leaked token for an ended pass opens nothing. Bad tokens are counted per source and lock it out.

import crypto from "node:crypto";
import { newPrefixedId } from "../../lib/id.js";
import { credentialAction } from "../../kernel/seal/uses.js";

/** The passes made for outside agents (appended to the vault's MIGRATIONS). */
export const MCP_PASSES_MIGRATION = `CREATE TABLE vault_mcp_passes (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, issuer TEXT NOT NULL, token_hash TEXT NOT NULL, items TEXT NOT NULL, hosts TEXT NOT NULL DEFAULT '[]', expires INTEGER NOT NULL,
     rate INTEGER NOT NULL, budget INTEGER, uses INTEGER NOT NULL DEFAULT 0, reveal INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER
   );
   CREATE TABLE vault_mcp_reveals (id TEXT PRIMARY KEY, pass TEXT NOT NULL, item TEXT NOT NULL, why TEXT, at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'asked', allowed_at INTEGER);`;

const DAY = 86_400_000, DEFAULT_DAYS = 7, MAX_DAYS = 90, DEFAULT_RATE = 30;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROTOCOL = "2025-06-18";
/** Bad tokens from one source before it is locked out, within the window, and for how long. */
export const LOCKOUT = { bad: 5, windowMs: 10 * 60_000, forMs: 10 * 60_000 };
/** A token bucket: `size` tokens refilled at `perMinute`, worked out from the clock when asked. */
class Bucket {
  constructor(/** @type {number} */ size, /** @type {number} */ perMinute, /** @type {() => number} */ now) { this.size = size; this.rate = perMinute / 60_000; this.now = now; this.tokens = size; this.at = now(); }
  take() { const t = this.now(); this.tokens = Math.min(this.size, this.tokens + (t - this.at) * this.rate); this.at = t; if (this.tokens < 1) return false; this.tokens -= 1; return true; }
}
const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });
const sha = (/** @type {string} */ t) => crypto.createHash("sha256").update(t).digest();

const TOOLS = [
  { name: "vault_list", description: "The credentials shared with you on this pass: name, kind, the hosts each is pinned to. Never a key, a password or a username.", inputSchema: { type: "object", properties: {} } },
  { name: "vault_request", description: "Make one HTTP call to a vendor API with a shared credential, at the vault's home. The key is added there and never shown to you. A read runs at once; anything that changes something waits for its owner to approve and answers { held }.",
    inputSchema: { type: "object", required: ["item", "method", "path"], properties: { item: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] }, path: { type: "string", description: "starting with /" }, query: { type: "object" }, body: {} } } },
];
const REVEAL_TOOL = { name: "vault_reveal_ask", description: "Ask the owner to let you see a shared value, once. Call with { item, why } to ask; the owner is asked and decides. Call again with { id } to see whether they allowed it: if so the value comes back one time and is then gone.", inputSchema: { type: "object", properties: { item: { type: "string" }, why: { type: "string" }, id: { type: "string" } } } };
/** An allowed reveal waits this long for the agent's next poll, then lapses. */
const REVEAL_WAIT_MS = 10 * 60_000;

export class PassMcp {
  /** @param {import("./vault.js").Vault} vault @param {{ requests: any, url?: () => string, log?: (m: string) => void }} deps requests: the ApiRequests relay (request.js) */
  constructor(vault, deps) {
    this.v = vault; this.db = vault.db; this.deps = deps; this.log = deps.log || (() => {});
    /** @type {Map<string, { n: number, since: number, until: number }>} */ this.misses = new Map();
    /** @type {Map<string, Bucket>} */ this.buckets = new Map();
    /** @type {Map<string, Bucket>} */ this.sources = new Map();
  }

  /** The loopback listener, set by index.js; the public address, set by the gate through vault.mcp.base. @type {{ port: number } | null} */ listener = null;
  /** @type {string | null} */ publicBase = null;
  listening() { return { listening: Boolean(this.listener), port: this.listener ? this.listener.port : null }; }
  /** Where an outsider reaches it: the public gate's address when there is one, else the loopback listener's. */
  addr() { return this.publicBase ? `${this.publicBase}/vault-mcp` : this.deps.url ? this.deps.url() : ""; }

  get K() { return this.v.access && this.v.access.K; }
  now() { return this.v.clock(); }
  actor(/** @type {string} */ id) { return `ext_${id.replace(/^vp_/, "")}`; }

  /**
   * Make a pass. `items` are api credentials; `hosts` narrows each credential's own hosts (never widens); `expires` is a time or milliseconds from now (at most 90 days).
   * Returns the token once. @param {{ name: string, items: string[], expires?: number, days?: number, rate?: number, budget?: number, hosts?: string[], reveal?: boolean }} i @param {string} issuer
   */
  async create(i, issuer) {
    const K = this.K;
    if (!K) throw bad("a pass is a grant in the Space, and this build has no kernel", "unavailable");
    await this.v.key();
    const name = String(i.name || "").trim().slice(0, 80);
    if (!name) throw bad("name who the pass is for");
    const items = [...new Set((Array.isArray(i.items) ? i.items : []).map(String))];
    if (!items.length || items.length > 50 || !items.every(n => NAME.test(n))) throw bad("name the credentials to share, up to 50");
    for (const n of items) { const r = this.v.row(n); if (!r || r.kind !== "api-credential") throw bad(`${n} is not an api-credential; only those are used through a pass`); }
    const t = this.now();
    const until = i.expires ? Number(i.expires) : t + Math.min(MAX_DAYS, Math.max(0.01, Number(i.days) || DEFAULT_DAYS)) * DAY;
    if (!(until > t) || until > t + MAX_DAYS * DAY + 1000) throw bad(`a pass lasts up to ${MAX_DAYS} days`);
    const hosts = (Array.isArray(i.hosts) ? i.hosts : []).map(String).slice(0, 20);
    const rate = Math.min(600, Math.max(1, Math.round(Number(i.rate) || DEFAULT_RATE)));
    const budget = i.budget ? Math.max(1, Math.round(Number(i.budget))) : null;
    const id = newPrefixedId("vp"), token = `vmcp_${crypto.randomBytes(32).toString("base64url")}`, who = this.actor(id);
    this.db.prepare("INSERT INTO vault_mcp_passes (id, name, issuer, token_hash, items, hosts, expires, rate, budget, reveal, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, name, issuer, sha(token).toString("hex"), JSON.stringify(items), JSON.stringify(hosts), until, rate, budget, i.reveal ? 1 : 0, t);
    await K.vault.carryOver(items.map(item => ({ id: `${id}:${item}`, kind: "pass", who, item, expires: until, rate })));
    this.v.audit("pass-mcp-create", null, issuer, true, `${name}: ${items.join(", ")}`);
    this.v.emit("vault.mcp-pass-made", { id, name, items });
    return { id, token, name, items, expires: until, rate, budget, reveal: Boolean(i.reveal), url: this.addr() };
  }

  /** What outside agents asked to see, waiting for the person (vault.pending). The value is never sent to them. */
  reveals() {
    return /** @type {any[]} */ (this.db.prepare("SELECT r.id, r.item, r.why, r.at, p.name AS pass FROM vault_mcp_reveals r JOIN vault_mcp_passes p ON p.id = r.pass WHERE r.state = 'asked' ORDER BY r.at").all()).map(r => ({ id: r.id, item: r.item, pass: r.pass, why: r.why || "", at: r.at }));
  }

  /** The person turns an ask down: it is cleared and the agent is told no. */
  clearReveal(/** @type {string} */ id) { return Number(this.db.prepare("UPDATE vault_mcp_reveals SET state='declined' WHERE id=? AND state='asked'").run(String(id)).changes) > 0; }

  /** The person's fresh yes (the tool's presence proof is that moment): this one value may be taken once by the pass that asked, within ten minutes. Nothing is read or kept here. */
  allowReveal(/** @type {string} */ id, /** @type {string} */ caller) {
    const r = /** @type {any} */ (this.db.prepare("SELECT r.*, p.name AS pname FROM vault_mcp_reveals r JOIN vault_mcp_passes p ON p.id = r.pass WHERE r.id=? AND r.state='asked' AND p.revoked IS NULL").get(String(id)));
    if (!r) throw bad(`no ask ${id} waiting`, "not_found");
    this.db.prepare("UPDATE vault_mcp_reveals SET state='allowed', allowed_at=? WHERE id=?").run(this.now(), r.id);
    this.v.audit("pass-mcp-reveal-allowed", r.item, caller, true, `once, to ${r.pname}`);
    return { allowed: true, item: r.item, pass: r.pname };
  }

  /** The passes, newest first, never a token. */
  list() {
    const t = this.now();
    return /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_mcp_passes ORDER BY created DESC").all()).map(p => ({
      id: p.id, name: p.name, items: JSON.parse(p.items), hosts: JSON.parse(p.hosts), expires: p.expires, rate: p.rate, budget: p.budget, uses: p.uses, reveal: Boolean(p.reveal),
      created: p.created, lastUsed: p.last_used ?? null, status: p.revoked ? "revoked" : p.expires <= t ? "expired" : "active" }));
  }

  /** End a pass: its grants are taken back and the token opens nothing. Needs no one. */
  async revoke(/** @type {string} */ id, /** @type {string} */ caller) {
    const p = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_mcp_passes WHERE id=?").get(String(id)));
    if (!p) throw bad(`no pass ${id}`, "not_found");
    if (p.revoked) return { revoked: false };
    this.db.prepare("UPDATE vault_mcp_passes SET revoked=? WHERE id=?").run(this.now(), p.id);
    const K = this.K;
    if (K) for (const g of K.vault.grantsOn(`vyre://${K.space}/vault/`)) if (g.source === `vault:pass:${this.actor(p.id)}`) await K.vault.takeBack({ id: g.id, reason: "the pass was ended" });
    this.db.prepare("UPDATE vault_mcp_reveals SET state='declined' WHERE pass=? AND state IN ('asked', 'allowed')").run(p.id);
    this.v.audit("pass-mcp-revoke", null, caller, true, p.name);
    this.v.emit("vault.mcp-pass-ended", { id: p.id, name: p.name });
    return { revoked: true };
  }

  /** Who is asking is only a source (an address); a refusal is an event and a count. */
  refuse(/** @type {string} */ source, /** @type {string} */ reason, /** @type {string} */ pass = "") {
    this.v.emit("vault.mcp-refused", { source: String(source).slice(0, 64), reason, ...(pass ? { pass } : {}) });
    this.v.audit("pass-mcp-refused", null, `source:${String(source).slice(0, 64)}`, false, reason);
  }

  /** The pass a token opens, or a refusal as { status }. Constant time over every pass; a source that sends too many wrong tokens is locked out. */
  auth(/** @type {string} */ token, /** @type {string} */ source) {
    const t = this.now();
    const m = this.misses.get(source);
    if (m && m.until > t) { this.refuse(source, "locked out"); return { status: 429 }; }
    let src = this.sources.get(source);
    if (!src) this.sources.set(source, src = new Bucket(120, 120, () => this.now()));
    if (!src.take()) { this.refuse(source, "too many requests"); return { status: 429 }; }
    const h = sha(String(token || ""));
    /** @type {any} */ let hit = null;
    for (const p of /** @type {any[]} */ (this.db.prepare("SELECT * FROM vault_mcp_passes").all())) if (crypto.timingSafeEqual(h, Buffer.from(p.token_hash, "hex"))) hit = p;
    if (!hit || hit.revoked || hit.expires <= t) {
      const x = m && t - m.since < LOCKOUT.windowMs ? m : { n: 0, since: t, until: 0 };
      x.n += 1; if (x.n >= LOCKOUT.bad) x.until = t + LOCKOUT.forMs;
      this.misses.set(source, x);
      this.refuse(source, hit ? (hit.revoked ? "ended pass" : "expired pass") : "unknown token", hit ? hit.id : "");
      return { status: 401 };
    }
    this.misses.delete(source);
    let b = this.buckets.get(hit.id);
    if (!b) this.buckets.set(hit.id, b = new Bucket(hit.rate, hit.rate, () => this.now()));
    if (!b.take()) { this.refuse(source, "pass rate", hit.id); return { status: 429 }; }
    return { pass: hit };
  }

  /** The address of an item under the pass's own grants, or null when the pass was not given it. */
  itemUrn(/** @type {any} */ pass, /** @type {string} */ item) {
    const K = this.K;
    if (!K) return null;
    const src = `vault:pass:${this.actor(pass.id)}`;
    const g = K.vault.grantsOn(`vyre://${K.space}/vault/`).find((/** @type {any} */ x) => x.source === src && x.resource.prefix.endsWith(`/item/${item}`));
    return g ? g.resource.prefix : null;
  }

  /** The items on this pass, by name and kind and the hosts they are pinned to. */
  async items(/** @type {any} */ pass) {
    const out = [];
    for (const name of JSON.parse(pass.items)) {
      const r = this.itemUrn(pass, name) ? this.v.row(name) : null;
      if (!r) continue;
      const hosts = (await this.v.apiCredential(name).then(c => c.config.hosts, () => [])).filter((/** @type {string} */ h) => !JSON.parse(pass.hosts).length || JSON.parse(pass.hosts).includes(h));
      out.push({ name, kind: r.kind, hosts });
    }
    return out;
  }

  /** The agent's poll for an ask it made: waiting, declined, or the value, once. The value is read now, from the vault, and is never stored, logged or kept. */
  async takeReveal(/** @type {any} */ pass, /** @type {string} */ id, /** @type {(ok: boolean, item: string | null, why: string) => void} */ note) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM vault_mcp_reveals WHERE id=? AND pass=?").get(id, pass.id));
    if (!r) throw bad("no such ask on this pass", "not_found");
    if (r.state === "asked") return { waiting: true };
    if (r.state === "declined") return { declined: true };
    if (r.state === "delivered") return { gone: true, message: "it was shown once and is gone" };
    if (this.now() - r.allowed_at > REVEAL_WAIT_MS) { this.db.prepare("UPDATE vault_mcp_reveals SET state='delivered' WHERE id=?").run(r.id); return { gone: true, message: "the answer lapsed; ask again" }; }
    const c = await this.v.apiCredential(r.item);
    this.db.prepare("UPDATE vault_mcp_reveals SET state='delivered' WHERE id=?").run(r.id);
    note(true, r.item, "the value was shown once");
    this.v.emit("vault.revealed-to-pass", { pass: pass.id, name: pass.name, item: r.item });
    return { value: c.secret, once: true };
  }

  /** One call of a tool, as the pass. @param {any} pass @param {string} tool @param {any} a @param {string} source */
  async call(pass, tool, a, source) {
    const who = `pass:${pass.id}:${pass.name}`.slice(0, 120);
    const note = (/** @type {boolean} */ ok, /** @type {string | null} */ item, /** @type {string} */ why) => this.v.audit("pass-mcp-use", item, who, ok, why);
    if (tool === "vault_list") return { items: await this.items(pass) };
    if (tool === "vault_reveal_ask") {
      if (!pass.reveal) throw bad("this pass cannot ask to see a value", "denied");
      if (a.id !== undefined) return this.takeReveal(pass, String(a.id), note);
      const item = String(a.item || "");
      if (!this.itemUrn(pass, item)) throw bad(`${item.slice(0, 80)} is not on this pass`, "not_found");
      const id = newPrefixedId("vr");
      this.db.prepare("INSERT INTO vault_mcp_reveals (id, pass, item, why, at) VALUES (?,?,?,?,?)").run(id, pass.id, item, String(a.why || "").slice(0, 200), this.now());
      note(true, item, "asked to see the value");
      this.v.emit("vault.reveal-asked", { pass: pass.id, name: pass.name, item });
      return { asked: true, id, message: "your request was sent to the owner; call again with this id to see their answer" };
    }
    if (tool !== "vault_request") throw bad("unknown tool", "not_found");
    const item = String(a.item || ""), method = String(a.method || "GET").toUpperCase(), K = this.K;
    const res = this.itemUrn(pass, item);
    // An item that is not on the pass is absent, not refused.
    if (!res || !K) throw bad(`${item.slice(0, 80)} is not on this pass`, "not_found");
    if (pass.budget != null && pass.uses >= pass.budget) { this.refuse(source, "pass budget", pass.id); throw bad("this pass has used its calls", "denied"); }
    const path = String(a.path || "");
    if (!path.startsWith("/") || path.startsWith("//") || /[?#\\\s]/.test(path)) throw bad("path starts with one / and carries no query (use query)");
    const cred = await this.v.apiCredential(item);
    const narrow = JSON.parse(pass.hosts);
    const host = (narrow.length ? cred.config.hosts.filter((/** @type {string} */ h) => narrow.includes(h)) : cred.config.hosts).find((/** @type {string} */ h) => !h.startsWith("*."));
    if (!host) throw bad(`${item} has no host this pass may reach`, "denied");
    const action = credentialAction("api", method);
    // The kernel decides, as the pass: its grants, the issuer's own, the expiry. A write is an outward act: it waits for a person (the relay holds it).
    const effect = await K.agentMay(this.actor(pass.id), action, res, undefined, true);
    if (effect !== "allow" && effect !== "ask") { note(false, item, `${method} refused`); throw bad(`${method} is not allowed on ${item}`, "denied"); }
    const base = /^https?:\/\//.test(host) ? host.replace(/\/$/, "") : `https://${host}`;
    this.db.prepare("UPDATE vault_mcp_passes SET uses = uses + 1, last_used = ? WHERE id = ?").run(this.now(), pass.id);
    note(true, item, `${method} ${new URL(base).hostname}${path.slice(0, 80)}`);
    const r = await this.deps.requests.forward({ credential: item, method, url: `${base}${path}`, query: a.query, body: a.body }, { caller: `runner:pass:${pass.id}` });
    if (r.held) return { held: r.held, message: `waiting for ${pass.issuer === "owner" ? "the owner" : "its owner"} to approve: ${r.summary || `${method} ${path}`}` };
    const text = Buffer.isBuffer(r.body) ? r.body.toString("utf8").slice(0, 200_000) : String(r.body ?? "");
    return { status: r.status, ok: r.ok, headers: r.headers || {}, body: text };
  }

  /**
   * One HTTP request to the endpoint: Streamable HTTP, a JSON-RPC message in a POST and a JSON answer. Pure of sockets (the listener, or a test, calls it).
   * @param {{ method: string, headers: Record<string, any>, body: string, source: string }} q @returns {Promise<{ status: number, body?: any, headers?: Record<string, string> }>}
   */
  async handle(q) {
    if (q.method !== "POST") return { status: 405 };
    const m = /^Bearer\s+(\S+)$/i.exec(String(q.headers.authorization || ""));
    const a = this.auth(m ? m[1] : "", q.source);
    if (!a.pass) return { status: a.status || 401 };
    const pass = a.pass;
    let msg;
    try { msg = JSON.parse(q.body); } catch { return { status: 400 }; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") return { status: 400 };
    const reply = (/** @type {any} */ result) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id, result } });
    const fail = (/** @type {number} */ code, /** @type {string} */ message) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id, error: { code, message } } });
    if (msg.id === undefined) return { status: 202 };
    if (msg.method === "initialize") return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "vyre-vault", version: "1" }, instructions: "Credentials shared with you. You can have calls made with them; you never see them." });
    if (msg.method === "ping") return reply({});
    if (msg.method === "tools/list") return reply({ tools: pass.reveal ? [...TOOLS, REVEAL_TOOL] : TOOLS });
    if (msg.method !== "tools/call" || !msg.params) return fail(-32601, "unknown method");
    try {
      const out = await this.call(pass, String(msg.params.name), msg.params.arguments || {}, q.source);
      return reply({ content: [{ type: "text", text: JSON.stringify(out) }], ...(out && out.held ? {} : {}) });
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (err && err.code === "denied") this.refuse(q.source, String(err.message).slice(0, 80), pass.id);
      return reply({ isError: true, content: [{ type: "text", text: String(err && err.message || "failed").slice(0, 300) }] });
    }
  }
}

/** The line the outsider runs, for Claude Code or Codex. @param {{ url: string, token: string, name?: string }} o */
export function mcpLines({ url, token, name = "vyre-vault" }) {
  return {
    claude: `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${token}"`,
    codex: `codex mcp add ${name} --url ${url} --bearer-token-env-var VYRE_VAULT_TOKEN   # then: export VYRE_VAULT_TOKEN=${token}`,
  };
}
