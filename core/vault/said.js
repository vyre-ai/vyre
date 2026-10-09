// @ts-check
// said_intents: what the person's own words asked to go out (PLAN.md P17, C25, "asking is
// approving"). At person-turn ingress sessions writes a `said` row that no model, teammate,
// watcher or tool result can produce; the assistant's extractor turns that text into intents
// {kind, channel, to[], what, when, standing, limits}; this file stores them and answers one
// question for the Gate: does an outward call match something the person said before it?
//
// Rules, and why:
// - There is no model-facing writer. `vault.said.record` is internal and refuses every caller
//   but module:sessions and module:assistant, so a tool result, an agent, a watcher or a guest
//   can never mark its own send as asked for.
// - A match is exact. Kind, channel (when the intent names one) and EVERY recipient must agree;
//   an email compares case-insensitively; a bare name is ambiguous and never matches. Pay needs
//   the payee exact and the amount inside the intent's limits. Nothing is guessed.
// - Only intents recorded before the call count, revoked ones never do, and a standing intent
//   matches in every thread while a plain one matches only in the call's own lineage.
// - The person's tools are list and revoke (through gate.said.*); a revoke needs no presence,
//   because taking permission away never does.
// - Rows are MACed like the vault's other tables (vault.js MACED): a row edited in vyre.db is
//   ignored and audited.
// Everything here is pure except the class, which only reads and writes its own table.

import { newPrefixedId } from "../../lib/id.js";

export const SAID_MIGRATION = `CREATE TABLE vault_said_intents (
     id TEXT PRIMARY KEY, thread TEXT NOT NULL, said TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT,
     recipients TEXT NOT NULL, what TEXT NOT NULL, when_text TEXT, standing INTEGER NOT NULL DEFAULT 0,
     limits TEXT, at INTEGER NOT NULL, revoked INTEGER, agents TEXT, used INTEGER, mac TEXT
   );
   CREATE INDEX vault_said_thread ON vault_said_intents (thread, at);`;

/** Every column but the MAC: what was said, where, to whom, how far it reaches and whether it still stands. */
export const SAID_MACED = ["id", "thread", "said", "kind", "channel", "recipients", "what", "when_text", "standing", "limits", "at", "revoked", "agents", "used"];

export const INTENT_KINDS = ["send", "post", "pay", "act_out", "setting", "revoke", "use"];
/** The only callers that may record what the person said. */
export const RECORDERS = ["module:sessions", "module:assistant", "module:threads"];
/** What the switchboard (module:threads), which hears the person's turn, may record: a # tag's use and an asked action, nothing else. */
export const THREADS_KINDS = ["use", "act_out"];
/** How long a plain (not standing) ask is good from when it was said, unless the recorder gave its own window (1 to 60 minutes): a stale "merge it" or "send that email" cannot be spent days later. */
export const PLAIN_WINDOW_MS = Object.freeze({ act_out: 15 * 60_000, setting: 15 * 60_000, revoke: 15 * 60_000, send: 60 * 60_000, post: 60 * 60_000, pay: 60 * 60_000 });
const MAX_TO = 20, MAX_TEXT = 500;

const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
const bad = msg => Object.assign(new Error(msg), { code: "bad_input" });

/** The intent kinds an outward call may be covered by. A Gate `send` may be a post; nothing else crosses. */
const COVERS = { send: ["send", "post"], post: ["post"], pay: ["pay"], spend: ["pay"], act_out: ["act_out"], delete: ["act_out"], act: ["act_out"], setting: ["setting"], revoke: ["revoke"], use: ["use"] };

/** A recipient as compared: trimmed and lower-cased, so an address differs only by what it says. */
export const norm = s => String(s ?? "").trim().toLowerCase();

/**
 * A bare name ("Dana", "the Harlow team") names no one exactly: no address, handle, channel, id,
 * number, domain or url in it. It never matches, even against the same string.
 */
export function ambiguous(s) {
  const v = norm(s);
  if (!v) return true;
  return !/[@#/:.\d_-]/.test(v);
}

/**
 * Whether one outward call is covered by something the person said.
 * @param {{ kind: string, channel?: string, via?: string, to?: string[], hosts?: string[], amount?: number, payee?: string, currency?: string, agent?: string, at?: number }} call
 * @param {{ id: string, thread: string, kind: string, channel?: string|null, to: string[], standing: boolean, limits?: any, at: number, revoked?: number|null }[]} intents
 * @param {string[]} lineage the call's thread and the threads it descends from
 * @returns {{ id: string } | null} the intent that covers it, the latest when several do
 */
export function matchIntent(call, intents, lineage = []) {
  const covers = COVERS[String(call && call.kind)];
  if (!covers) return null;
  const at = Number.isFinite(call.at) ? /** @type {number} */ (call.at) : Date.now();
  const channels = new Set([call.channel, call.via, String(call.via || "").split(":").pop()].filter(Boolean).map(norm));
  const pay = covers[0] === "pay";
  const dests = pay ? [call.payee].filter(Boolean) : (call.to || []);
  if (!dests.length) return null;
  /** @type {any} */
  let best = null;
  for (const it of intents || []) {
    if (!it || it.revoked || !covers.includes(it.kind)) continue;
    // A plain ask is used up by the send it asked for; only a standing permission persists.
    if (it.used && !it.standing) continue;
    // A plain act_out ask is for now, not for days: it stops matching after its window (15 minutes unless the recorder said otherwise).
    if (!it.standing && PLAIN_WINDOW_MS[it.kind] && at > it.at + (it.limits && Number.isFinite(it.limits.window_ms) ? it.limits.window_ms : PLAIN_WINDOW_MS[it.kind])) continue;
    // An intent that names agents covers only them; one that names none covers any of the person's agents.
    if (it.agents && it.agents.length && !it.agents.map(norm).includes(norm(call.agent))) continue;
    if (!(it.at <= at)) continue;
    if (!it.standing && !lineage.includes(it.thread)) continue;
    if (it.channel && !channels.has(norm(it.channel))) continue;
    // A "use" intent names a vault item, which is a plain word: the exact name is enough, and the
    // hosts the item had when the person tagged it must still cover the item's hosts now.
    const use = covers[0] === "use";
    if (use && it.limits && Array.isArray(it.limits.hosts) && !(Array.isArray(call.hosts) && call.hosts.every(h => it.limits.hosts.map(norm).includes(norm(h))))) continue;
    const named = new Set((it.to || []).filter(x => use || !ambiguous(x)).map(norm));
    if (!named.size) continue;
    if (!dests.every(d => (use || !ambiguous(d)) && named.has(norm(d)))) continue;
    if (pay) {
      const max = it.limits && Number(it.limits.max_amount);
      if (!Number.isFinite(max) || !Number.isFinite(call.amount) || /** @type {number} */ (call.amount) < 0 || /** @type {number} */ (call.amount) > max) continue;
      if (!it.limits.currency || !call.currency || norm(it.limits.currency) !== norm(call.currency)) continue;
    }
    if (!best || it.at >= best.at) best = it;
  }
  return best ? { id: best.id } : null;
}

/** The stored row as a caller sees it. */
const out = r => ({ id: r.id, thread: r.thread, said: r.said, kind: r.kind, channel: r.channel ?? null, to: json(r.recipients, []), what: r.what,
  when: r.when_text ?? null, standing: Boolean(r.standing), limits: json(r.limits, null), at: Number(r.at), revoked: r.revoked ? Number(r.revoked) : null,
  agents: json(r.agents, []), used: r.used ? Number(r.used) : null });

export class SaidIntents {
  /** @param {import("./vault.js").Vault} vault */
  constructor(vault) { this.vault = vault; }

  /**
   * Store one intent. The caller has already been checked as sessions or assistant.
   * @param {any} i @param {string} caller
   */
  async record(i, caller) {
    if (!isObj(i)) throw bad("an intent is an object");
    if (caller === "module:threads" && !THREADS_KINDS.includes(i.kind)) throw bad(`the threads module records only ${THREADS_KINDS.join(" and ")} intents`);
    if (typeof i.thread !== "string" || !i.thread) throw bad("thread is the session the person spoke in");
    if (typeof i.said !== "string" || !i.said) throw bad("said is the id of the ingress row the words came from");
    if (!INTENT_KINDS.includes(i.kind)) throw bad(`kind must be one of ${INTENT_KINDS.join(", ")}`);
    const to = Array.isArray(i.to) ? i.to : [];
    if (to.length > MAX_TO || !to.every(x => typeof x === "string" && x.trim() && x.length <= 320)) throw bad(`to is up to ${MAX_TO} addresses, handles or channels`);
    if (typeof i.what !== "string" || !i.what.trim()) throw bad("what says what was asked for");
    for (const k of ["channel", "when"]) if (i[k] !== undefined && i[k] !== null && (typeof i[k] !== "string" || i[k].length > 200)) throw bad(`${k} is a short string`);
    let limits = null;
    if (i.limits !== undefined && i.limits !== null) {
      if (!isObj(i.limits)) throw bad("limits is an object");
      const max = i.limits.max_amount;
      if (max !== undefined && !(typeof max === "number" && Number.isFinite(max) && max >= 0)) throw bad("limits.max_amount is a number");
      if (i.limits.currency !== undefined && (typeof i.limits.currency !== "string" || i.limits.currency.length > 8)) throw bad("limits.currency is a short code");
      const hosts = i.kind === "use" && Array.isArray(i.limits.hosts) && i.limits.hosts.every(h => typeof h === "string" && h.length <= 253) ? i.limits.hosts.slice(0, 50) : undefined;
      limits = { ...(max !== undefined ? { max_amount: max } : {}), ...(i.limits.currency ? { currency: i.limits.currency } : {}), ...(hosts ? { hosts } : {}) };
    }
    if (i.kind === "pay" && !(limits && limits.max_amount !== undefined && limits.currency)) throw bad("a pay intent needs limits.max_amount and limits.currency");
    if (i.window_minutes !== undefined) {
      if (!(Number.isFinite(i.window_minutes) && i.window_minutes > 0)) throw bad("window_minutes is a number of minutes");
      limits = { ...(limits || {}), window_ms: Math.round(Math.min(60, Math.max(1, i.window_minutes)) * 60_000) };
    }
    if (i.kind === "use" && !(limits && Array.isArray(limits.hosts))) throw bad("a use intent carries the item's hosts as limits.hosts; record it through vault.mention.resolve");
    if (i.agents !== undefined && !(Array.isArray(i.agents) && i.agents.length <= MAX_TO && i.agents.every(x => typeof x === "string" && x.trim() && x.length <= 80))) throw bad("agents is a list of agent names");
    const agents = (i.agents || []).map(x => x.trim());
    const at = Number.isFinite(i.at) ? Number(i.at) : Date.now();
    await this.vault.key();
    const id = newPrefixedId("s");
    this.vault.db.prepare(`INSERT INTO vault_said_intents (id, thread, said, kind, channel, recipients, what, when_text, standing, limits, at, agents)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, i.thread, i.said, i.kind, i.channel || null, JSON.stringify(to.map(String)), i.what.trim().slice(0, MAX_TEXT),
      i.when || null, i.standing === true ? 1 : 0, limits ? JSON.stringify(limits) : null, at, agents.length ? JSON.stringify(agents) : null);
    this.vault.sign("vault_said_intents", id);
    this.vault.audit("said-record", null, caller, true, `${i.kind}${i.standing === true ? " standing" : ""} in ${i.thread}`);
    return { id };
  }

  /** Every row that passes its MAC, oldest first. @param {{ thread?: string, all?: boolean }} [f] */
  rows(f = {}) {
    const sql = f.thread ? "SELECT * FROM vault_said_intents WHERE thread = ? ORDER BY at, id" : "SELECT * FROM vault_said_intents ORDER BY at, id";
    const rows = /** @type {any[]} */ (f.thread ? this.vault.db.prepare(sql).all(f.thread) : this.vault.db.prepare(sql).all());
    return rows.filter(r => this.vault.rowOk("vault_said_intents", r)).filter(r => f.all || !r.revoked);
  }

  /** What the person sees: live intents (revoked ones too with `all`), never a value. @param {{ thread?: string, all?: boolean }} [f] */
  list(f = {}) { return { intents: this.rows(f).map(out) }; }

  /** The person takes one back. It stops covering anything at once. @param {{ id: string }} input @param {string} caller */
  revoke({ id }, caller) {
    const r = /** @type {any} */ (this.vault.db.prepare("SELECT * FROM vault_said_intents WHERE id = ?").get(String(id)));
    if (!r || !this.vault.rowOk("vault_said_intents", r)) throw Object.assign(new Error(`no intent ${String(id).slice(0, 40)}`), { code: "not_found" });
    if (r.revoked) return { id: r.id, revoked: Number(r.revoked) };
    const t = Date.now();
    this.vault.db.prepare("UPDATE vault_said_intents SET revoked = ? WHERE id = ? AND revoked IS NULL").run(t, r.id);
    this.vault.sign("vault_said_intents", r.id);
    this.vault.audit("said-revoke", null, caller, true, `${r.kind} in ${r.thread}`);
    return { id: r.id, revoked: t };
  }

  /**
   * The Gate's question. Reads only rows that pass their MAC and are not revoked.
   * @param {any} call @param {{ thread?: string, lineage?: string[] }} [where]
   */
  async match(call, where = {}, consume = false) {
    await this.vault.key();
    const lineage = [...new Set([...(where.thread ? [where.thread] : []), ...(where.lineage || [])].map(String))];
    const intents = this.rows().map(out);
    const m = matchIntent(call, intents, lineage);
    if (!m || !consume) return m;
    // A plain ask is used up by the send it asked for: claim it before anything goes out, so two
    // calls cannot both ride it. A standing permission is never used up.
    const it = intents.find(x => x.id === m.id);
    if (it && !it.standing && it.kind !== "use") {
      const r = this.vault.db.prepare("UPDATE vault_said_intents SET used = ? WHERE id = ? AND used IS NULL").run(Date.now(), m.id);
      if (!r.changes) return null;
      this.vault.sign("vault_said_intents", m.id);
    }
    return m;
  }

  /**
   * A standing permission the person added themselves on a person surface (Settings). The caller,
   * module:gate, has already checked it acts for a person surface; the row says so in `said`.
   * @param {any} i @param {string} surface
   */
  async add(i, surface) {
    const to = Array.isArray(i.to) ? i.to : [];
    return this.record({ thread: "settings", said: `person:${surface}`, kind: i.kind, channel: i.channel, to, what: i.what || `${i.kind} ${to.join(", ")}`, standing: true,
      limits: i.limits, agents: i.agents }, `module:gate/${surface}`);
  }
}

const str = { type: "string" };
const strs = { type: "array", items: str };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/**
 * Register the intent tools. `internal` makes a tool only other modules can call.
 * @param {{ vault: import("./vault.js").Vault, tool?: Function, emit?: (type: string, payload: any) => void, internal: (name: string, description: string, input: any, run: Function) => void }} o
 */
export function register({ vault, internal, tool, emit }) {
  const said = new SaidIntents(vault);

  internal("vault.said.record", "Store what the person's own turn asked for. Only sessions and the assistant call it, after extracting it from a `said` row; nothing a model, agent, watcher or tool result produces can.",
    obj({ thread: str, said: str, kind: { type: "string", enum: INTENT_KINDS }, channel: str, to: strs, what: str, when: str, standing: { type: "boolean" }, agents: strs, window_minutes: { type: "number" },
      limits: obj({ max_amount: { type: "number" }, currency: str, hosts: strs }), at: { type: "integer" } }, ["thread", "said", "kind", "what"]),
    (input, { caller }) => {
      if (!RECORDERS.includes(String(caller))) { vault.audit("said-record", null, caller, false, "not sessions or the assistant"); throw new Error("only sessions and the assistant record what the person said"); }
      return said.record(input, String(caller));
    });

  internal("vault.said.match", "Whether an outward call is covered by something the person said before it: kind, channel and every recipient exact, pay by payee and amount within limits. { matched, id? }. The Gate asks before it holds.",
    obj({ kind: str, channel: str, via: str, to: strs, amount: { type: "number" }, payee: str, currency: str, agent: str, consume: { type: "boolean" }, thread: str, lineage: strs, at: { type: "integer" } }, ["kind"]),
    async input => {
      const { thread, lineage, consume, ...call } = input;
      const m = await said.match(call, { thread, lineage }, consume === true);
      return m ? { matched: true, id: m.id } : { matched: false };
    });

  internal("vault.said.add", "The person adds a standing permission from a person surface (Settings). Only the Gate calls it, after it has checked the caller is the person's own surface.",
    obj({ surface: str, kind: { type: "string", enum: INTENT_KINDS }, channel: str, to: strs, what: str, agents: strs, limits: obj({ max_amount: { type: "number" }, currency: str }) }, ["surface", "kind", "to"]),
    (input, { caller }) => {
      if (String(caller) !== "module:gate") { vault.audit("said-add", null, caller, false, "not the gate"); throw new Error("only the Gate adds a permission the person typed in Settings"); }
      const { surface, ...rest } = input;
      return said.add(rest, String(surface));
    });

  internal("vault.said.list", "The intents the person has voiced, live ones unless `all`; the Gate's gate.said.list shows them to the person.",
    obj({ thread: str, all: { type: "boolean" } }), input => said.list(input));

  internal("vault.said.revoke", "Take an intent back. The Gate's gate.said.revoke calls this for the person; no proof of presence, since removing permission never needs one.",
    obj({ id: str }, ["id"]), (input, { caller }) => said.revoke(input, String(caller)));

  // ---- "#" vault mentions: the person tags an item and that thread may USE it, never see it ----

  /** The pickable items: names, kinds and bound hosts only. Never a value, never an ssh key's private half. */
  const pickable = (q = "") => vault.list({ filter: q }).items.filter(i => i.kind !== "ssh-key").map(i => ({ name: i.name, kind: i.kind, hosts: i.hosts || [], ...(i.description ? { description: String(i.description).slice(0, 120) } : {}) }));
  const RESOLVERS = ["module:sessions", "module:assistant", "module:threads", "module:mentions"];

  if (tool) {
    tool("vault.items.names", ["cli", "local", "deck", "capsule", "tailnet", "device", "space", "agent"], "Names, kinds and bound hosts of the vault items a person may tag with #, for pickers. Never a value.",
      obj({ q: str, kind: str, limit: { type: "integer" } }), ({ q, kind, limit }) => ({ items: pickable(q).filter(i => !kind || i.kind === kind).slice(0, Math.min(Number(limit) || 30, 100)) }));
    tool("vault.mention.search", ["cli", "local", "deck", "capsule", "tailnet", "device", "space", "agent"], "The # picker's vault items: id and name are the item name, hint says the kind and host.",
      obj({ q: str, limit: { type: "integer" } }), ({ q, limit }) => ({ items: pickable(q).slice(0, Math.min(Number(limit) || 30, 100)).map(i => ({ id: i.name, name: i.name, hint: `${i.kind}${i.hosts.length ? " · " + i.hosts.join(", ") : ""}`, icon: "key" })) }));
  }

  internal("vault.mention.resolve", "The person tagged #item in their own turn: record that this thread (and the threads under it) may use the item, bound to the hosts it has now. Only sessions and the assistant; answers what the tag grants, never a value.",
    obj({ id: str, thread: str, said: str }, ["id", "thread"]),
    async ({ id, thread, said: ref }, { caller }) => {
      if (!RESOLVERS.includes(String(caller))) { vault.audit("mention-resolve", String(id || "") || null, caller, false, "not sessions or the assistant"); throw new Error("only sessions and the assistant resolve a # tag"); }
      const it = pickable().find(x => x.name === String(id));
      if (!it) throw Object.assign(new Error(`no vault item ${String(id).slice(0, 60)}`), { code: "not_found" });
      const r = await said.record({ thread, said: ref || `mention:${id}`, kind: "use", to: [it.name], what: `use ${it.name}`, standing: false, limits: { hosts: it.hosts } },
        RESOLVERS.includes(String(caller)) && String(caller) !== "module:mentions" ? String(caller) : "module:sessions");
      return { name: it.name, hint: `${it.kind}${it.hosts.length ? " · " + it.hosts.join(", ") : ""}`, hosts: it.hosts, note: "You may use this credential through vault.request and connectors. You never see its value.", grant: { use: true, hosts: it.hosts }, intent: r.id };
    });

  internal("vault.use.check", "Whether a thread (or a thread it descends from) may use a vault item because the person tagged it. { item, thread, lineage?, hosts? } -> { allowed, id? }. Never a value. A host the item has now that it did not have at the tag ends the permission.",
    obj({ item: str, thread: str, lineage: strs, hosts: strs }, ["item", "thread", "hosts"]),
    async ({ item, thread, lineage, hosts }) => {
      const m = await said.match({ kind: "use", to: [String(item)], ...(hosts ? { hosts } : {}) }, { thread, lineage });
      return m ? { allowed: true, id: m.id } : { allowed: false };
    });

  internal("vault.use.note", "A quiet record that a tagged item was used: emits vault.used {item, thread, via} with no value.",
    obj({ item: str, thread: str, via: str }, ["item"]),
    ({ item, thread, via }, { caller }) => { vault.audit("used", String(item), String(caller), true, `via ${String(via || "?").slice(0, 40)}`); if (emit) emit("vault.used", { item: String(item), thread: thread || null, via: via || null }); return { ok: true }; });

  return said;
}
