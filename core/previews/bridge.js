// @ts-check
// previews/bridge: what a preview's page can reach, shaped like Claude's artifact runtime so a Claude-style page runs unchanged (`window.claude.use(name)`: db, user, sample, permissions, downloads in this
// cut; room, assets, files and mcp are 0.3.2). Served on the preview's own origin under /__vyre/ (the apps' front forwards a signed `x-vyre-viewer` header: who is looking and their role), and only for a preview
// that DECLARED capabilities (previews.open { capabilities } or .vyre/preview.json). Nothing is on by default: a declared capability still asks the viewer at its first use, the answer is kept per person and
// preview, and a no is a `null` from use(). The page's own code is never constrained; this adds a way in, and only on request.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePath, badBody, mergeDeep, MAX_DOCS } from "./docs.js";

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "client", "claude.js");
export const CAPS = ["db", "user", "sample", "downloads"]; // permissions is built in and never declared
export const LEVELS = ["view", "interact", "admin", "owner"];
const lvl = (/** @type {string} */ l) => LEVELS.indexOf(l);
const MAX_BODY = 512 * 1024, MAX_SUBS = 64, PER_MIN = 240;

/** @param {string} key @param {string} header @param {number} [maxAgeMs] @param {string} [scope] the preview it must have been made for (host name pv-<id>); a header made for another preview, or for none, is refused when one is named */
export function readViewer(key, header, maxAgeMs = 9 * 3_600_000, scope = undefined) {
  const [body, mac] = String(header || "").split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", key).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); return v && typeof v.w === "string" && Date.now() - Number(v.t) < maxAgeMs && (scope === undefined || v.p === scope) ? { w: v.w, r: String(v.r || ""), t: Number(v.t) } : null; } catch { return null; }
}

/** The viewer's level on a preview, in Claude's words: the maker is `owner`, a Space owner or admin `admin`, a member `interact`, anyone else `view`. @param {{ created_by: string | null }} row @param {{ w: string, r: string }} v */
export const levelOf = (row, v) => (row.created_by && v.w === row.created_by ? "owner" : v.r === "owner" || v.r === "admin" ? "admin" : v.r === "member" ? "interact" : "view");

/** The opaque id a page sees for a person, different on every preview. @param {string} preview @param {string} who */
export const selfId = (preview, who) => crypto.createHash("sha256").update(`${preview}|${who}`).digest("hex").slice(0, 20);

/**
 * The minimum level for an action at a path, from the declared rules (the nearest rule at or above the path wins, each of read and write inherited separately), and whether the path is another viewer's private
 * subtree. @param {any[]} rules @param {string[]} segs @param {string} self
 */
export function ruleFor(rules, segs, self) {
  const list = (Array.isArray(rules) ? rules : []).map(r => ({ segs: String(r && r.path || "").split("/").filter(Boolean), read: r && r.read, write: r && r.write })).filter(r => r.segs.length || true);
  let read = "view", write = "interact", privateTo = null;
  // the built-in rule: each person's own data/users/<id> is private
  const selfRules = [{ prefix: ["data", "users"] }, ...list.filter(r => r.segs[r.segs.length - 1] === "{self}").map(r => ({ prefix: r.segs.slice(0, -1) }))];
  for (const sr of selfRules) {
    if (segs.length > sr.prefix.length && sr.prefix.every((s, i) => segs[i] === s)) {
      const opened = list.some(r => r.segs.length === sr.prefix.length && r.segs.every((s, i) => s === sr.prefix[i]) && r.read && r.write);
      if (!opened && segs[sr.prefix.length] !== self) privateTo = segs[sr.prefix.length];
    }
  }
  const best = (/** @type {"read"|"write"} */ k) => { let b = null; for (const r of list) { const own = r.segs.length === 0 || (r.segs[r.segs.length - 1] === "{self}" ? segs.length >= r.segs.length && r.segs.slice(0, -1).every((s, i) => segs[i] === s) && segs[r.segs.length - 1] === self : r.segs.every((s, i) => segs[i] === s) && segs.length >= r.segs.length); if (own && r[k] && LEVELS.includes(r[k]) && (!b || r.segs.length >= b.segs.length)) b = r; } return b ? b[k] : null; };
  read = best("read") || read; write = best("write") || write;
  if (lvl(write) < lvl(read)) write = read; // writing implies reading
  return { read, write, privateTo };
}

/**
 * @param {{ row: (id: string) => any, grants: { get: (id: string, who: string, cap: string) => number | null, set: (id: string, who: string, cap: string, allowed: boolean) => void }, docs: any, call: (tool: string, input: any) => Promise<any>,
 *   key: string, nameOf: (who: string) => Promise<string>, log?: (m: string) => void }} o
 */
export function createBridge(o) {
  const clientJs = () => { try { return fs.readFileSync(CLIENT, "utf8"); } catch { return "/* the bridge script is missing */"; } };
  /** @type {Map<string, Set<{ res: import("node:http").ServerResponse, w: string, level: string, self: string, kind: "doc" | "query", path: string, q: any, last: string }>>} */
  const subs = new Map();
  /** @type {Map<string, Map<string, { name: string }>>} who a page has met, by opaque id, since this start */
  const met = new Map();
  /** @type {Map<string, number[]>} */ const rate = new Map();

  const declared = (/** @type {any} */ row) => { try { const c = JSON.parse(row.caps || "null"); return c && typeof c === "object" && !Array.isArray(c) ? c : {}; } catch { return {}; } };
  const json = (/** @type {import("node:http").ServerResponse} */ res, /** @type {number} */ code, /** @type {any} */ body) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; };
  const fail = (/** @type {import("node:http").ServerResponse} */ res, /** @type {number} */ http, /** @type {string} */ code, /** @type {string} */ message) => json(res, http, { error: { code, message } });
  const readBody = (/** @type {import("node:http").IncomingMessage} */ req) => new Promise((resolve, reject) => { const c = /** @type {Buffer[]} */ ([]); let n = 0; req.on("data", d => { n += d.length; if (n > MAX_BODY) { reject(Object.assign(new Error("too large"), { code: "invalid_argument" })); req.destroy(); } else c.push(d); }); req.on("end", () => resolve(Buffer.concat(c).toString("utf8"))); req.on("error", reject); });
  const throttled = (/** @type {string} */ k) => { const t = Date.now(), l = (rate.get(k) || []).filter(x => t - x < 60_000); l.push(t); rate.set(k, l); return l.length > PER_MIN; };

  /** The state of a capability for this viewer. @param {any} row @param {string} who @param {string} cap */
  const stateOf = (row, who, cap) => {
    if (cap === "permissions") return "granted";
    if (!(cap in declared(row))) return "unavailable";
    const g = o.grants.get(row.id, who, cap);
    return g === null ? "prompt" : g ? "granted" : "denied";
  };
  const need = (/** @type {any} */ row, /** @type {string} */ who, /** @type {string} */ cap) => {
    const s = stateOf(row, who, cap);
    if (s === "unavailable" || s === "denied") throw Object.assign(new Error(`${cap} is not available to this page`), { code: "not_granted" });
    if (s === "prompt") throw Object.assign(new Error(`${cap} needs the viewer's permission`), { code: "consent_required" });
  };

  // ---- db ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  /** Can this viewer read / write at this path. @param {any} row @param {any} v @param {string[]} segs */
  const access = (row, v, segs) => {
    const level = levelOf(row, { w: v.w, r: v.r });
    const self = selfId(row.id, v.w);
    const rules = (declared(row).db || {}).rules;
    const r = ruleFor(rules, segs, self);
    const meets = (/** @type {string} */ need) => level === "owner" || lvl(level) >= lvl(need);
    return { read: !r.privateTo && meets(r.read), write: !r.privateTo && meets(r.write), level, self };
  };
  /** Evaluate a query in memory over the documents of one collection. @param {any[]} docs @param {any} q */
  const runQuery = (docs, q) => {
    let out = docs.filter(d => (q.where || []).every((/** @type {any} */ w) => matches(d.data[w.field], w.op, w.value)));
    if (q.orderBy) { const { field, dir } = q.orderBy; out = [...out].sort((a, b) => { const x = a.data[field], y = b.data[field]; if (x === undefined && y === undefined) return a.id < b.id ? -1 : 1; if (x === undefined) return 1; if (y === undefined) return -1; const c = x < y ? -1 : x > y ? 1 : 0; return (dir === "desc" ? -c : c) || (a.id < b.id ? -1 : 1); }); }
    else out = [...out].sort((a, b) => (a.id < b.id ? -1 : 1));
    return out.slice(0, Math.min(Math.max(Number(q.limit) || 1000, 1), 1000));
  };
  const matches = (/** @type {any} */ a, /** @type {string} */ op, /** @type {any} */ b) => {
    switch (op) {
      case "==": return JSON.stringify(a) === JSON.stringify(b);
      case "!=": return JSON.stringify(a) !== JSON.stringify(b);
      case "<": return a !== undefined && a < b; case "<=": return a !== undefined && a <= b; case ">": return a !== undefined && a > b; case ">=": return a !== undefined && a >= b;
      case "in": return Array.isArray(b) && b.some(x => JSON.stringify(x) === JSON.stringify(a));
      case "not-in": return Array.isArray(b) && !b.some(x => JSON.stringify(x) === JSON.stringify(a));
      case "array-contains": return Array.isArray(a) && a.some(x => JSON.stringify(x) === JSON.stringify(b));
      default: throw Object.assign(new Error(`${op} is not a query operator`), { code: "invalid_argument" });
    }
  };
  const cleanQuery = (/** @type {any} */ q) => {
    const where = Array.isArray(q && q.where) ? q.where : [];
    if (where.length > 10) throw Object.assign(new Error("a query has at most 10 filters"), { code: "invalid_argument" });
    for (const w of where) { if (!w || typeof w.field !== "string" || typeof w.op !== "string") throw Object.assign(new Error("a filter is { field, op, value }"), { code: "invalid_argument" }); if ((w.op === "in" || w.op === "not-in") && (!Array.isArray(w.value) || w.value.length > 30)) throw Object.assign(new Error("in and not-in take an array of at most 30"), { code: "invalid_argument" }); }
    return { where, orderBy: q && q.orderBy && typeof q.orderBy.field === "string" ? { field: q.orderBy.field, dir: q.orderBy.dir === "desc" ? "desc" : "asc" } : null, limit: q && q.limit ? Math.min(Math.max(Number(q.limit) | 0, 1), 1000) : 1000 };
  };
  const pathOf = (/** @type {string} */ p, /** @type {"doc"|"collection"} */ kind) => {
    const r = parsePath(p);
    if ("error" in r) throw Object.assign(new Error(r.error), { code: "invalid_argument" });
    if ((kind === "doc") !== r.doc) throw Object.assign(new Error(kind === "doc" ? "a document path has an even number of segments" : "a collection path has an odd number of segments"), { code: "invalid_argument" });
    return r;
  };
  /** The documents of a collection this viewer may read, in a query's order. @param {any} row @param {any} v @param {string} collection @param {any} q */
  const readCollection = async (row, v, collection, q) => {
    const docs = await o.docs.list(row.id, collection);
    const out = docs.filter((/** @type {any} */ d) => access(row, v, d.path.split("/")).read);
    return runQuery(out, q);
  };
  const snapshot = (/** @type {any[]} */ docs) => docs.map(d => ({ id: d.id, path: d.path, data: d.data }));

  /** Tell every live subscriber that something under `path` changed: each gets its full current snapshot again, when it differs from the last it was sent. @param {any} row @param {string} path */
  async function changed(row, path) {
    const set = subs.get(row.id); if (!set) return;
    const coll = parsePath(path);
    const collection = "collection" in coll ? coll.collection : "";
    for (const s of [...set]) {
      try {
        let payload;
        if (s.kind === "doc") { if (s.path !== path) continue; const d = await o.docs.get(row.id, path); payload = { exists: Boolean(d && s.canRead), data: d && s.canRead ? d.data : undefined }; }
        else { if (s.path !== collection) continue; payload = { docs: snapshot(await readCollection(row, { w: s.w, r: s.r }, s.path, s.q)) }; }
        const text = JSON.stringify(payload);
        if (text === s.last) continue;
        s.last = text;
        s.res.write(`event: snapshot\ndata: ${text}\n\n`);
      } catch (e) { o.log?.(`previews: a subscriber could not be told: ${/** @type {Error} */ (e).message}`); }
    }
  }

  /** Every op. @param {any} row @param {any} v @param {string} op @param {any} a */
  async function run(row, v, op, a) {
    const [cap, name] = op.split(".");
    if (cap === "caps") {
      const dec = declared(row);
      const state = Object.fromEntries([...Object.keys(dec).filter(k => CAPS.includes(k)), "permissions"].map(k => [k, stateOf(row, v.w, k)]));
      return { title: row.title, declared: Object.keys(dec).filter(k => CAPS.includes(k)), state, level: levelOf(row, v) };
    }
    if (cap === "permissions") {
      if (name === "grant") {
        const names = (Array.isArray(a && a.names) ? a.names : []).map(String).filter(n => CAPS.includes(n) && n in declared(row));
        for (const n of names) o.grants.set(row.id, v.w, n, a.allow === true);
        return Object.fromEntries(names.map(n => [n, stateOf(row, v.w, n)]));
      }
      throw Object.assign(new Error("no such call"), { code: "capability_removed" });
    }
    need(row, v.w, cap);
    if (cap === "user") {
      const level = levelOf(row, v), self = selfId(row.id, v.w);
      const nm = await o.nameOf(v.w);
      if (!met.has(row.id)) met.set(row.id, new Map());
      /** @type {Map<string, { name: string }>} */ (met.get(row.id)).set(self, { name: nm });
      if (name === "info") return { id: self, name: nm, isOwner: level === "owner", canEdit: lvl(level) >= lvl("admin") || level === "owner", can: { "data.write": level === "owner" || lvl(level) >= lvl("interact") }, level };
      if (name === "profiles") { const ids = Array.isArray(a && a.ids) ? a.ids.map(String).slice(0, 200) : []; const m = met.get(row.id) || new Map(); return Object.fromEntries(ids.map(id => [id, { id, name: (m.get(id) || { name: "" }).name, avatarUrl: "", color: "", email: null, isMe: id === self, guest: false }])); }
      throw Object.assign(new Error("no such call"), { code: "capability_removed" });
    }
    if (cap === "sample") {
      if (name === "limits") return { maxPromptBytes: 60_000 };
      if (name === "complete") {
        const input = a && a.input;
        const prompt = typeof input === "string" ? input : Array.isArray(input) ? input.map((/** @type {any} */ m) => `${m && m.role === "assistant" ? "Assistant" : "User"}: ${String(m && m.content || "")}`).join("\n\n") + "\n\nAssistant:" : "";
        if (!prompt || Buffer.byteLength(prompt) > 60_000) throw Object.assign(new Error("give a prompt of at most 60 KB"), { code: "invalid_argument" });
        if (throttled(`s|${row.id}|${v.w}`) || (rate.get(`s|${row.id}|${v.w}`) || []).length > 20) throw Object.assign(new Error("too many requests: wait a minute and call again"), { code: "rate_limited" });
        const r = await o.call("threads.quick", { purpose: "helper", prompt, spend_purpose: "previews-sample", timeout_ms: 60_000 });
        if (r.error) throw Object.assign(new Error(r.error.message || "the model did not answer"), { code: r.error.code === "denied" ? "not_granted" : "unavailable" });
        return { text: String(r.data && r.data.text || ""), truncated: false, modelTierApplied: "default" };
      }
      throw Object.assign(new Error("no such call"), { code: "capability_removed" });
    }
    if (cap === "downloads") { if (name === "check") return { ok: true }; throw Object.assign(new Error("no such call"), { code: "capability_removed" }); }
    if (cap === "db") {
      if (throttled(`d|${row.id}|${v.w}`)) throw Object.assign(new Error("slow down"), { code: "resource_exhausted" });
      if (name === "get") {
        const p = pathOf(a.path, "doc");
        if (!access(row, v, p.segs).read) return { exists: false };
        const d = await o.docs.get(row.id, a.path); return d ? { exists: true, data: d.data } : { exists: false };
      }
      if (name === "query") {
        const p = pathOf(a.path, "collection");
        return { docs: snapshot(await readCollection(row, v, p.collection, cleanQuery(a.query))) };
      }
      if (name === "set" || name === "update" || name === "delete") {
        const p = pathOf(a.path, "doc");
        if (!access(row, v, p.segs).write) throw Object.assign(new Error("this viewer cannot write there"), { code: "invalid_argument" });
        if (name !== "delete") { const bad = badBody(a.data); if (bad) throw Object.assign(new Error(bad), { code: "invalid_argument" }); }
        if (name === "set") { if (!(await o.docs.get(row.id, a.path)) && (await o.docs.count(row.id)) >= MAX_DOCS) throw Object.assign(new Error("this page's database is full: 25,000 documents"), { code: "quota_exceeded" }); await o.docs.set(row.id, a.path, a.data, v.w); }
        else if (name === "update") await o.docs.update(row.id, a.path, a.data);
        else await o.docs.del(row.id, a.path);
        void changed(row, a.path);
        return {};
      }
      if (name === "acquire") {
        const p = pathOf(a.path, "doc");
        if (!access(row, v, p.segs).write) throw Object.assign(new Error("this viewer cannot write there"), { code: "invalid_argument" });
        const holder = String(a.holder || ""); const ttl = Math.min(Math.max(Number(a.ttlMs) || 30_000, 1000), 600_000);
        if (!holder) throw Object.assign(new Error("a lease needs a holder"), { code: "invalid_argument" });
        const cur = await o.docs.get(row.id, a.path); const lease = cur && cur.data && cur.data.__lease;
        if (lease && lease.holder !== holder && lease.expires > Date.now()) return { acquired: false, expiresAt: new Date(lease.expires).toISOString() };
        const expires = Date.now() + ttl;
        const body = mergeDeep(cur ? cur.data : {}, { ...(a.data && typeof a.data === "object" ? a.data : {}), __lease: { holder, expires } });
        const bad = badBody(body); if (bad) throw Object.assign(new Error(bad), { code: "invalid_argument" });
        await o.docs.set(row.id, a.path, body, v.w); void changed(row, a.path);
        return { acquired: true, holder, expiresAt: new Date(expires).toISOString() };
      }
    }
    throw Object.assign(new Error("no such call"), { code: "capability_removed" });
  }

  /** The http door under /__vyre/. @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @param {string} id @param {URL} url */
  async function api(req, res, id, url) {
    const row = o.row(id);
    if (!row) return false;
    if (url.pathname === "/__vyre/claude.js" && req.method === "GET") {
      if (!row.caps) return false;
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(clientJs());
      return true;
    }
    if (!row.caps) return false;
    const v = readViewer(o.key, String(req.headers["x-vyre-viewer"] || ""), undefined, `pv-${row.id}`);
    if (!v) return fail(res, 401, "not_granted", "sign in to the preview again");
    if (url.pathname === "/__vyre/api/stream" && req.method === "GET") return stream(req, res, row, v, url);
    if (url.pathname !== "/__vyre/api" || req.method !== "POST") return false;
    if (req.headers["x-page-bridge"] !== "1") return fail(res, 403, "not_granted", "that request is not from the page");
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = await run(row, v, String(body.op || ""), body.args || {});
      return json(res, 200, { data: out });
    } catch (e) {
      const err = /** @type {any} */ (e);
      const code = typeof err.code === "string" && /^[a-z_]+$/.test(err.code) ? err.code : "unavailable";
      return fail(res, code === "consent_required" ? 409 : 400, code, String(err.message || "that did not work").slice(0, 300));
    }
  }

  /** A live subscription: a server-sent stream of full snapshots. @param {any} req @param {any} res @param {any} row @param {any} v @param {URL} url */
  async function stream(req, res, row, v, url) {
    try { need(row, v.w, "db"); } catch (e) { return fail(res, 409, /** @type {any} */ (e).code, "the page needs the viewer's permission for stored data"); }
    const set = subs.get(row.id) || new Set(); subs.set(row.id, set);
    if ([...set].filter(s => s.w === v.w).length >= MAX_SUBS) return fail(res, 429, "resource_exhausted", "at most 64 subscriptions per view");
    let kind, p, q = null;
    try {
      kind = url.searchParams.get("kind") === "query" ? "query" : "doc";
      p = pathOf(String(url.searchParams.get("path") || ""), kind === "doc" ? "doc" : "collection");
      if (kind === "query") q = cleanQuery(JSON.parse(url.searchParams.get("q") || "{}"));
    } catch (e) { return fail(res, 400, /** @type {any} */ (e).code || "invalid_argument", String(/** @type {Error} */ (e).message)); }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    const level = levelOf(row, v);
    const sub = { res, w: v.w, r: v.r, level, self: selfId(row.id, v.w), kind, path: kind === "doc" ? url.searchParams.get("path") || "" : p.collection, q, last: "", canRead: kind === "doc" ? access(row, v, p.segs).read : true };
    set.add(/** @type {any} */ (sub));
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    req.on("close", () => { clearInterval(beat); set.delete(/** @type {any} */ (sub)); });
    // the first snapshot
    try {
      let payload;
      if (kind === "doc") { const d = sub.canRead ? await o.docs.get(row.id, sub.path) : null; payload = { exists: Boolean(d), data: d ? d.data : undefined }; }
      else payload = { docs: snapshot(await readCollection(row, v, p.collection, q)) };
      sub.last = JSON.stringify(payload);
      res.write(`event: snapshot\ndata: ${sub.last}\n\n`);
    } catch (e) { res.write(`event: failure\ndata: ${JSON.stringify({ code: "unavailable", message: String(/** @type {Error} */ (e).message) })}\n\n`); }
    return true;
  }

  return { api, run, changed, closeAll() { for (const [, set] of subs) for (const s of set) { try { s.res.end(); } catch { /* gone */ } } subs.clear(); }, forget(/** @type {string} */ id) { for (const s of subs.get(id) || []) { try { s.res.end(); } catch { /* gone */ } } subs.delete(id); met.delete(id); } };
}
