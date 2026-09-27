// @ts-check
// gate: held items, and the one path from "an agent wants this to go out" to "it went out".
//
// Floor rules 1 and 2 (docs/SPEC.md section 11): nothing goes out as the user until they have
// seen the final words, and they always see where it is going. So an agent never sends; it asks
// the Gate to, and the Gate keeps the request as a row until a person approves or discards it.
// The person may edit it first. What is sent is exactly what they approved, with the credential
// added at the boundary by the sender, so the agent never holds it.
//
// Design choices, and why:
// - The id is nine random bytes. A button on a phone carries it, and whoever presents it answers.
// - held -> sending is one UPDATE guarded by state, so two surfaces pressing Send at once send once.
// - A failed send goes back to held with its error: the person approved it and may try again.
// - Events say that something was held or sent and where; never the content. Every module reads
//   the log, and a draft is the user's words.
// - What the person changed before approving is a signal (section 7.11). The draft is kept
//   beside the final, and the difference is taught to Memory as draft.edited.
//
// This class has no ctx: its dependencies are injected, so tests can use fake senders.

import crypto from "node:crypto";
import { TYPES, problem, scrub } from "./senders.js";

export const MIGRATIONS = [
  `CREATE TABLE gate_items (
     id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, via TEXT NOT NULL, dest TEXT NOT NULL,
     draft TEXT NOT NULL, final TEXT, why TEXT, agent TEXT, thread TEXT, project TEXT,
     state TEXT NOT NULL, error TEXT, result TEXT, by TEXT, decided INTEGER
   );
   CREATE INDEX gate_items_state ON gate_items (state, at);`,
  // Where the agent first addressed it, so a revision that changes `to` still counts as an edit.
  `ALTER TABLE gate_items ADD COLUMN draft_dest TEXT;`,
  // The module whose offered sender an item was held under, so after a restart, before that module
  // offers again, Approve can say which module to start rather than "no such sender".
  `ALTER TABLE gate_items ADD COLUMN sender_module TEXT;`,
  // Where the item sits in its session, so a surface can open the transcript at it: the tool call
  // that asked (when the caller knows it) and the id of the gate.held event.
  `ALTER TABLE gate_items ADD COLUMN tool_use_id TEXT;
   ALTER TABLE gate_items ADD COLUMN event INTEGER;`,
];

export const KINDS = ["send", "spend", "delete"];
/** Words in an MCP tool's own name that mean it sends something as the user (as core/harness/rules.js). */
const SENDS = /(^|[_-])(send|post|reply|forward|publish|share|invite|tweet|dm|comment)([_-]|$)/i;
const READS = /(^|_)(draft|list|get|search|read)(_|$)/i;
/**
 * The MCP hub's tools inside Vyre's own MCP server (ADR 0016), as `vyre mcp` or as the plugin:
 * a hub server name, then its tool. The hub holds their outward calls at the Gate itself.
 */
const HUB = /^mcp__(?:vyre|plugin_vyre_vyre)__[a-z][a-z0-9-]{0,31}__./;
/**
 * Vyre module tools with a send word that hold at the Gate themselves, so route would deny an
 * agent the very path the Gate wants it to take. google.mail.send is always held (ADR 0016
 * decision 6). A Vyre tool that really sends, such as threads_send, is not listed and is denied.
 * Kept the same as core/harness/rules.js.
 */
const GATED = new Set(["google_mail_send"].flatMap(t => [`mcp__vyre__${t}`, `mcp__plugin_vyre_vyre__${t}`]));
const MAX_SNIPPETS = 12, SNIPPET = 160, MAX_WORDS = 1500;

const json = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const isObject = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * A sender a module offered (gate.offer). The Gate holds, shows and records it like any other;
 * the module's own internal tool sends exactly the approved content, and checks the rest itself.
 * @param {{ name: string, tool: string, kinds: string[], content: Record<string, string> }} o
 */
const moduleType = o => ({
  kinds: o.kinds, content: o.content,
  check(to, c) { if (!isObject(c)) throw new Error("content must be an object"); },
  summary: (to, c) => cut(String(c.summary || c.subject || c.tool || o.name), 120),
  async send(to, c, s, deps) {
    const r = await deps.call(o.tool, { id: deps.id, to, content: c });
    if (r && r.error) throw new Error(r.error.message || r.error.code || `${o.tool} failed`);
    return r ? r.data : null;
  },
});

/**
 * @typedef {{ db: import("node:sqlite").DatabaseSync, emit: (type: string, payload: any, where?: any) => any,
 *   fetchCredential: (item: string, field?: string) => Promise<string>, relay: (input: any) => Promise<any>,
 *   teach?: (kind: string, fact: any) => Promise<any>, senders?: Record<string, any>, fetch?: typeof fetch,
 *   now?: () => number, types?: Record<string, any>, log?: (m: string) => void,
 *   call?: (tool: string, input: any) => Promise<any> }} GateDeps
 */

export class Gate {
  /** @param {GateDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.db = deps.db;
    this.types = deps.types || TYPES;
    this.now = deps.now || Date.now;
    /** @type {Record<string, any>} */
    this.senderConfig = {};
    for (const [name, s] of Object.entries(deps.senders || {})) {
      const bad = this.types === TYPES ? problem(name, s) : (this.types[s?.type] ? null : `sender ${name} has an unknown type`);
      if (bad) deps.log?.(`gate: ${bad}; it is left out`);
      else this.senderConfig[name] = s;
    }
    /** Senders modules offered since this vyred started, by name. @type {Record<string, any>} */
    this.offered = {};
  }

  /**
   * A module offers a sender of its own: a name in its namespace and one of its own tools that
   * sends. Offering the same name again replaces it, since a module offers at every start.
   * @param {{ name: string, tool: string, kinds?: string[], content?: Record<string, string> }} input
   * @param {string} caller
   */
  offer({ name, tool, kinds, content }, caller) {
    const m = /^module:(.+)$/.exec(String(caller || ""))?.[1];
    if (!m) throw new Error("only a module offers a sender");
    name = String(name || ""); tool = String(tool || "");
    if (!(name === m || name.startsWith(m + ":") || name.startsWith(m + "-"))) throw new Error(`${m} may offer only a sender named ${m}, ${m}:<name> or ${m}-<name>`);
    if (!tool.startsWith(m + ".")) throw new Error(`${m} may offer only one of its own tools (${m}.<name>) to send`);
    if (this.senderConfig[name]) throw new Error(`${name} is a sender configured in config.json`);
    if (this.offered[name] && this.offered[name].module !== m) throw new Error(`${name} is already offered by ${this.offered[name].module}`);
    if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.length || kinds.some(k => !KINDS.includes(k)))) throw new Error(`kinds must be some of ${KINDS.join(", ")}`);
    if (content !== undefined && !isObject(content)) throw new Error("content must be an object describing what the sender takes");
    this.offered[name] = { module: m, name, tool, kinds: kinds || [...KINDS], content: content || {} };
    return { name, kinds: this.offered[name].kinds };
  }

  /**
   * Items left in "sending" by a vyred that stopped mid-send. Whether they went out is unknown, so
   * they go back to held with that said: the person decides, rather than the Gate sending twice.
   */
  recover() {
    const r = this.db.prepare("UPDATE gate_items SET state = 'held', error = ? WHERE state = 'sending'")
      .run("vyred stopped while this was being sent; it may already have gone out. Check before approving again.");
    return Number(r.changes);
  }

  /** The `via` values that exist, and what each takes. Never a credential or an item name. */
  senders() {
    return Object.entries(this.senderConfig).map(([name, s]) => {
      const t = this.types[s.type];
      return { name, type: s.type, kinds: s.kinds || t.kinds, content: t.content, ...(s.hosts ? { hosts: s.hosts } : {}) };
    }).concat(Object.values(this.offered).map(o => ({ name: o.name, type: "module", module: o.module, kinds: o.kinds, content: o.content })));
  }

  sender(via) {
    const s = this.senderConfig[via];
    const o = s ? null : this.offered[via];
    if (o) return { s: { type: "module", module: o.module }, t: moduleType(o) };
    if (!s) {
      const names = [...Object.keys(this.senderConfig), ...Object.keys(this.offered)];
      throw new Error(`no sender "${via}"${names.length ? `; the senders are ${names.join(", ")}` : "; none is configured (gate.senders in config.json)"}`);
    }
    return { s, t: this.types[s.type] };
  }

  /** A held item's sender, or why a module's one is not here (its module has not offered it since vyred started). */
  senderOf(r) {
    if (r.sender_module && !this.senderConfig[r.via] && !this.offered[r.via]) throw new Error(`the ${r.via} sender is not available; is the ${r.sender_module} module running?`);
    return this.sender(r.via);
  }

  /**
   * An agent asks for something to go out. It is held, never sent from here.
   * @param {{ kind: string, via: string, to: string|string[], content: any, why?: string, thread?: string, project?: string, tool_use_id?: string }} input
   * @param {{ agent?: string|null }} [who]
   */
  request({ kind, via, to, content, why, thread, project, tool_use_id }, { agent = null } = {}) {
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    const { s, t } = this.sender(via);
    const kinds = s.kinds || t.kinds;
    if (!kinds.includes(kind)) throw new Error(`sender ${via} does not ${kind}; it takes ${kinds.join(", ")}`);
    const dest = (Array.isArray(to) ? to : [to]).map(String).filter(Boolean);
    if (!dest.length) throw new Error("say where it is going: to");
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("content must be an object");
    t.check(dest, content, s);
    const id = crypto.randomBytes(9).toString("hex");
    this.db.prepare(`INSERT INTO gate_items (id, at, kind, via, dest, draft_dest, draft, why, agent, thread, project, state, sender_module, tool_use_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'held', ?, ?)`).run(id, this.now(), kind, via, JSON.stringify(dest), JSON.stringify(dest), JSON.stringify(content),
      why ? cut(String(why), 1000) : null, agent, thread || null, project || null, s.module || null, tool_use_id ? cut(String(tool_use_id), 100) : null);
    const summary = t.summary(dest, content);
    const ev = this.deps.emit("gate.held", { id, kind, via, to: dest, summary, agent, thread: thread || null, project: project || null }, where(thread, project));
    if (ev && typeof ev.id === "number") this.db.prepare("UPDATE gate_items SET event = ? WHERE id = ?").run(ev.id, id);
    return { id, state: "held", message: `Held at the Gate as ${id}. The user sees it, with where it is going, and nothing goes out until they approve it. Do not send it another way.` };
  }

  /** Held items, oldest first: what has waited longest should be answered first. */
  held({ thread, project } = {}) {
    let sql = "SELECT * FROM gate_items WHERE state = 'held'";
    const args = [];
    if (thread) { sql += " AND thread = ?"; args.push(thread); }
    if (project) { sql += " AND project = ?"; args.push(project); }
    return this.db.prepare(sql + " ORDER BY at").all(...args).map(r => this.brief(r));
  }

  brief(r) {
    const draft = json(r.final, null) || json(r.draft, {});
    const t = this.senderConfig[r.via] || this.offered[r.via] ? this.sender(r.via).t : null;
    return { id: r.id, kind: r.kind, via: r.via, to: json(r.dest, []), summary: t ? t.summary(json(r.dest, []), draft) : "",
      why: r.why, agent: r.agent, thread: r.thread, project: r.project, at: r.at, ...(r.error ? { error: r.error } : {}),
      // Where it sits in its session. Without a tool_use_id (a model's MCP call rarely knows its
      // own), a surface finds it by thread and at, or by the gate.held event.
      anchor: { tool_use_id: r.tool_use_id || null, event: r.event == null ? null : Number(r.event), thread: r.thread || null, at: r.at } };
  }

  row(id) {
    const r = /** @type {any} */ (this.db.prepare("SELECT * FROM gate_items WHERE id = ?").get(String(id)));
    if (!r) throw new Error(`nothing at the Gate has id ${id}`);
    return r;
  }

  /** One item in full: the draft, what was finally sent, and the difference. */
  get({ id }) {
    const r = this.row(id);
    const draft = json(r.draft, {}), final = json(r.final, null);
    return { ...this.brief(r), state: r.state, draft, final, diff: final ? diff(draft, final) : { removed: [], added: [] },
      result: json(r.result, null), error: r.error || null, by: r.by || null, decided: r.decided || null };
  }

  /**
   * A person approved it, maybe after editing. Send exactly that.
   * @param {{ id: string, edited?: any, by?: string }} input
   */
  async approve({ id, edited, by }) {
    const r = this.row(id);
    if (r.state !== "held") throw new Error(`${id} is already ${r.state}`);
    const { s, t } = this.senderOf(r);
    const draft = json(r.draft, {});
    const { dest, final } = this.merge(r, edited);
    const taken = this.db.prepare("UPDATE gate_items SET state = 'sending', final = ?, dest = ?, by = ? WHERE id = ? AND state = 'held'")
      .run(JSON.stringify(final), JSON.stringify(dest), by || null, id);
    if (Number(taken.changes) === 0) throw new Error(`${id} is already ${this.row(id).state}`);
    const w = where(r.thread, r.project);
    try {
      const result = await t.send(dest, final, s, { fetchCredential: this.deps.fetchCredential, relay: this.deps.relay, fetch: this.deps.fetch, call: this.deps.call, id });
      this.db.prepare("UPDATE gate_items SET state = 'sent', result = ?, error = NULL, decided = ? WHERE id = ?").run(JSON.stringify(result ?? null), this.now(), id);
      const edits = diff(draft, final);
      const changed = edits.removed.length > 0 || edits.added.length > 0 || JSON.stringify(dest) !== (r.draft_dest ?? r.dest);
      this.deps.emit("gate.released", { id, kind: r.kind, via: r.via, to: dest, edited: changed, by: by || null, agent: r.agent, thread: r.thread, project: r.project }, w);
      if (changed && this.deps.teach) await this.teachEdit(r, dest, edits).catch(() => {});
      return { id, state: "sent", result: result ?? null };
    } catch (e) {
      // Senders scrub their own errors; this is a second net for anything that slipped past.
      const error = cut(scrub(String(/** @type {Error} */ (e)?.message || e), []), 500);
      this.db.prepare("UPDATE gate_items SET state = 'held', error = ? WHERE id = ?").run(error, id);
      this.deps.emit("gate.failed", { id, via: r.via, error: cut(error, 200) }, w);
      return { id, state: "failed", error };
    }
  }

  /**
   * The edited words and destination over what is there now (the last revision, else the draft).
   * `edited` may be the whole content or only the fields that changed; a field given as "" clears
   * it. Checked with the sender's own check, so a revision the sender would refuse is refused now.
   * @param {any} r the row @param {any} edited
   */
  merge(r, edited) {
    const { s, t } = this.senderOf(r);
    const base = json(r.final, null) || json(r.draft, {});
    let dest = json(r.dest, []);
    if (edited === undefined) return { dest, final: base };
    if (!edited || typeof edited !== "object" || Array.isArray(edited)) throw new Error("edited must be an object: the content as it should go out, or the fields that changed");
    const { to, ...fields } = edited;
    if (to !== undefined) dest = (Array.isArray(to) ? to : [to]).map(String).map(x => x.trim()).filter(Boolean);
    const final = { ...base };
    for (const [k, v] of Object.entries(fields)) { if (v === "" || v === null) delete final[k]; else final[k] = v; }
    if (!dest.length) throw new Error("say where it is going: to");
    t.check(dest, final, s);
    return { dest, final };
  }

  /**
   * A person changed the words (or where they go) and has not sent yet. Held stays held; Send
   * then sends exactly this revision, which is what every surface now shows.
   * @param {{ id: string, edited: any, by?: string }} input
   */
  revise({ id, edited, by }) {
    const r = this.row(id);
    if (r.state !== "held") throw new Error(`${id} is already ${r.state}`);
    const { dest, final } = this.merge(r, edited);
    const done = this.db.prepare("UPDATE gate_items SET final = ?, dest = ?, by = ? WHERE id = ? AND state = 'held'")
      .run(JSON.stringify(final), JSON.stringify(dest), by || null, id);
    if (Number(done.changes) === 0) throw new Error(`${id} is already ${this.row(id).state}`);
    this.deps.emit("gate.revised", { id, via: r.via, to: dest, by: by || null, agent: r.agent, thread: r.thread, project: r.project }, where(r.thread, r.project));
    return this.get({ id });
  }

  /** A person discarded it. Nothing is sent. @param {{ id: string, reason?: string, by?: string }} input */
  reject({ id, reason, by }) {
    const r = this.row(id);
    const done = this.db.prepare("UPDATE gate_items SET state = 'rejected', error = ?, by = ?, decided = ? WHERE id = ? AND state = 'held'")
      .run(reason ? cut(String(reason), 500) : null, by || null, this.now(), id);
    if (Number(done.changes) === 0) throw new Error(`${id} is already ${this.row(id).state}`);
    this.deps.emit("gate.rejected", { id, kind: r.kind, via: r.via, by: by || null, reason: reason ? cut(String(reason), 200) : null }, where(r.thread, r.project));
    return { id, state: "rejected" };
  }

  /**
   * harness.rules asks this about a sending MCP tool. Inside an agent's thread, sending directly
   * is denied and the agent is pointed at the Gate; in the user's own session the interim "ask
   * first" rule stays, since the user is there to see the words.
   * @param {{ tool: string, input?: any, agent?: string, session?: string }} call
   */
  route({ tool, agent }) {
    if (!agent || !String(tool).startsWith("mcp__") || HUB.test(String(tool)) || GATED.has(String(tool))) return { decision: null };
    const own = String(tool).split("__").pop() || "";
    if (!SENDS.test(own) || READS.test(own)) return { decision: null };
    const names = Object.keys(this.senderConfig);
    const how = names.length
      ? `Call the Vyre tool gate_request with via one of: ${names.join(", ")} (gate_senders says what each takes).`
      : "No Gate sender is configured, so it cannot go out yet; tell the user what you would send and to whom.";
    return { decision: "deny", reason: `Agents do not send directly. The Gate holds it until the user approves the final words. ${how}` };
  }

  /** What the person changed, for Memory: who it went to, whose draft, and a one-line diff. */
  async teachEdit(r, dest, edits) {
    const line = [edits.removed.length && `removed "${edits.removed.slice(0, 3).join('", "')}"`, edits.added.length && `added "${edits.added.slice(0, 3).join('", "')}"`].filter(Boolean).join("; ");
    const fact = { subject: dest[0] && /@/.test(dest[0]) ? { email: dest[0] } : { name: dest[0] || r.via },
      text: cut(`The user edited ${r.agent || "an agent"}'s ${r.kind} via ${r.via} before approving it: ${line || "changed the recipients"}`, 400),
      at: this.now(), key: `gate:${r.id}` };
    await this.deps.teach?.("draft.edited", fact);
  }
}

const where = (thread, project) => ({ ...(thread ? { thread } : {}), ...(project ? { project } : {}) });

/**
 * Word-level difference between two contents, field by field: contiguous removed and added runs,
 * capped. A field longer than MAX_WORDS is compared whole.
 * @returns {{ removed: string[], added: string[] }}
 */
export function diff(a, b) {
  const removed = [], added = [];
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
  for (const k of keys) {
    const x = text(a?.[k]), y = text(b?.[k]);
    if (x === y) continue;
    const xs = x.split(/\s+/).filter(Boolean), ys = y.split(/\s+/).filter(Boolean);
    if (xs.length > MAX_WORDS || ys.length > MAX_WORDS) { if (x) removed.push(cut(x, SNIPPET)); if (y) added.push(cut(y, SNIPPET)); continue; }
    const runs = words(xs, ys);
    removed.push(...runs.removed); added.push(...runs.added);
  }
  return { removed: removed.slice(0, MAX_SNIPPETS), added: added.slice(0, MAX_SNIPPETS) };
}

const text = v => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** LCS over words, then the runs that are not common. */
function words(xs, ys) {
  const n = xs.length, m = ys.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const removed = [], added = [];
  let i = 0, j = 0, rem = [], add = [];
  const flush = () => { if (rem.length) removed.push(cut(rem.join(" "), SNIPPET)); if (add.length) added.push(cut(add.join(" "), SNIPPET)); rem = []; add = []; };
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) { flush(); i++; j++; }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) add.push(ys[j++]);
    else rem.push(xs[i++]);
  }
  flush();
  return { removed, added };
}
