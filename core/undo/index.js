// @ts-check
// undo: the shared acted-log (PLAN P14, PL-M9).
//
// Whatever an agent, the assistant, a watcher or a module does on the person's behalf that can be
// reversed is recorded here, with the inverse the module that did it declared: the tool to run and
// the input to run it with, built by that module from what it actually did. A model never supplies
// an inverse: undo.record is reach "modules" (internal), so only Vyre's own modules can write a
// row, and the default-deny in core/modules keeps an added module out as well.
//
// The log lives in its own module, not the assistant's, so watchers and every other module keep
// their Undo path when the assistant is switched off.
//
// An inverse is refused when the registry does not know its tool, when a module caller could not
// run it, and when it is outward (send, post, pay, delete), needs presence, or is the person's own
// (PERSON_ONLY, HUMAN_ONLY, or callers of the person's surfaces alone). The same check runs again
// at undo time, so a tool that became outward since cannot be replayed.
//
// Whose authority undo.run uses: P14 wants the original actor's caller, never the person's. The
// kernel does not let a module call as another caller: ctx.call's `as` is limited to the labels
// CALL_AS lists (link and settings only), and a person's label is never one of them. So the
// inverse runs as this module's own caller, "module:undo": a module caller, never a person's, which
// is the part of P14 that matters for safety (presence and person-only tools stay out of reach,
// and the inverse check above refuses them anyway). Running it as the original actor needs a
// CALL_AS entry for undo in core/modules, which is the platform's to add.

import { agentClaim, callerKind } from "../modules/index.js";
import { isPerson as isPersonCaller } from "../../lib/caller.js";
import { HUMAN_ONLY, PERSON_ONLY, personOnly } from "../presence/index.js";
import { newPrefixedId } from "../../lib/id.js";

const DAY = 24 * 60 * 60_000;
export const KEEP_MS = 30 * DAY;
const PRUNE_EVERY_MS = DAY;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const TEXT_MAX = 200;
const TOOL = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/;
export const KINDS = /** @type {const} */ (["assistant", "agent", "module", "person"]);

export const MIGRATIONS = [`
CREATE TABLE undo_acted (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  input TEXT NOT NULL,
  inverse_tool TEXT NOT NULL,
  inverse_input TEXT NOT NULL,
  why TEXT,
  state TEXT NOT NULL DEFAULT 'done',
  undone_at INTEGER,
  undone_by TEXT,
  error TEXT
);
CREATE INDEX undo_acted_at ON undo_acted (at);
CREATE INDEX undo_acted_actor ON undo_acted (actor_kind, actor, at);
`];

/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });
const one = (/** @type {unknown} */ s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cap = (/** @type {string} */ s, n = TEXT_MAX) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const plain = (/** @type {unknown} */ v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Delete rows older than KEEP_MS. @param {any} db @param {number} [now] @returns {number} rows removed */
export const prune = (db, now = Date.now()) => Number(db.prepare("DELETE FROM undo_acted WHERE at < ?").run(now - KEEP_MS).changes || 0);

/** The person on one of their own surfaces or devices, never an agent naming one. @param {string} caller */
export const isPerson = caller => isPersonCaller(caller);

/** The same actor, however its transport labels it ("mcp:agent:juno" and "harness:agent:juno"). @param {string} a @param {string} b */
export const sameActor = (a, b) => {
  if (String(a) === String(b)) return true;
  const x = agentClaim(a), y = agentClaim(b);
  return Boolean(x) && x === y;
};

/** Only the audit ids a module may attach: {said} and {rule}, each a short string. @param {unknown} why */
const cleanWhy = why => {
  if (!plain(why)) return null;
  const w = /** @type {any} */ (why), out = /** @type {Record<string, string>} */ ({});
  for (const k of ["said", "rule"]) if (typeof w[k] === "string" && w[k].trim()) out[k] = cap(w[k].trim(), 120);
  return Object.keys(out).length ? out : null;
};

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const self = `module:${ctx.name}`;

    const say = (type, payload) => {
      try { ctx.events.emit(type, payload); } catch (e) { ctx.log(`could not say ${type}: ${/** @type {Error} */ (e).message}`); }
    };

    const tidy = () => { try { const n = prune(db); if (n) ctx.log(`pruned ${n} acted rows older than 30 days`); } catch (e) { ctx.log(`prune failed: ${/** @type {Error} */ (e).message}`); } };
    tidy();
    const timer = setInterval(tidy, PRUNE_EVERY_MS);
    timer.unref();

    // Agent name to kind ("assistant" or "agent"). A kind never changes once an agent exists, so a
    // hit is kept; a miss asks agents.list again. Without the agents module, every agent is "agent".
    /** @type {Map<string, string>} */
    const kinds = new Map();
    const agentKind = async (/** @type {string} */ name) => {
      if (kinds.has(name)) return /** @type {string} */ (kinds.get(name));
      try {
        const r = await ctx.call("agents.list", {});
        if (r && !r.error && Array.isArray(r.data)) for (const a of r.data) if (a && typeof a.name === "string") kinds.set(a.name, a.kind === "assistant" ? "assistant" : "agent");
      } catch { /* the agents module is off or absent here */ }
      return kinds.get(name) || "agent";
    };
    const kindOf = async (/** @type {string} */ actor) => {
      const claim = agentClaim(actor);
      if (claim) return agentKind(claim);
      if (callerKind(actor) === "module") return "module";
      if (isPerson(actor)) return "person";
      return "agent";
    };

    /**
     * Why an inverse may not be replayed, or null when it may. Looked up in the live registry.
     * @param {string} name @returns {string | null}
     */
    const refuse = name => {
      if (typeof name !== "string" || !TOOL.test(name)) return "the inverse needs a tool name";
      if (name.startsWith("undo.")) return "an inverse cannot be undo's own tool";
      if (PERSON_ONLY.has(name) || HUMAN_ONLY.has(name) || personOnly(name)) return `${name} is the person's own action and has no inverse`;
      const all = /** @type {any[]} */ (ctx.modules.tools());
      const def = all.find(t => t.name === name);
      if (!def) return `no tool ${name} is running here`;
      if (def.outward) return `${name} acts as the person outside (${def.outward}) and has no inverse`;
      if (def.presence) return `${name} needs the person present and has no inverse`;
      if (!(/** @type {any[]} */ (ctx.modules.tools(self))).some(t => t.name === name)) return `${name} is not open to modules`;
      return null;
    };

    const shape = r => ({ id: r.id, at: r.at, actor: r.actor, actor_kind: r.actor_kind, tool: r.tool, summary: r.summary, state: r.state,
      why: r.why ? JSON.parse(r.why) : null, can_undo: (r.state === "done" || r.state === "failed") && refuse(r.inverse_tool) === null });

    ctx.tool("undo.record", {
      description: "Record an action a module took for the person, with the inverse that module declares: {tool, input, summary, inverse: {tool, input}, actor?, why?}. actor is the caller the action ran for (meta.caller of the call that did it); it defaults to the recording module. why holds audit ids only ({said} or {rule}). Refused when the inverse is unknown, outward, needs presence or is the person's own. Returns {id}.",
      input: { type: "object", required: ["tool", "input", "summary", "inverse"], properties: {
        tool: { type: "string" }, input: { type: "object" }, summary: { type: "string" },
        inverse: { type: "object", required: ["tool", "input"], properties: { tool: { type: "string" }, input: { type: "object" } } },
        actor: { type: "string" }, why: { type: "object" } } },
      examples: [{ tool: "planner.add", input: { title: "Call alex" }, summary: "Added a reminder to call alex", inverse: { tool: "planner.remove", input: { item: "i1" } }, actor: "mcp:agent:juno" }],
      run: async (i, meta = {}) => {
        if (!TOOL.test(i.tool)) throw fail("bad_input", "tool must be a tool name");
        const summary = cap(one(i.summary));
        if (!summary) throw fail("bad_input", "summary must say what was done");
        if (!plain(i.input) || !plain(i.inverse) || !plain(i.inverse.input)) throw fail("bad_input", "input and inverse.input must be objects");
        const why = refuse(i.inverse.tool);
        if (why) throw fail("bad_input", why);
        // The actor: the recording module passes the caller its own tool ran for, since the loader
        // does not carry a call chain; without one, the action is the module's own.
        const actor = cap(one(i.actor), 200) || String(meta.caller || self);
        const actor_kind = await kindOf(actor);
        const id = newPrefixedId("u");
        const w = cleanWhy(i.why);
        db.prepare(`INSERT INTO undo_acted (id, at, actor, actor_kind, tool, summary, input, inverse_tool, inverse_input, why, state)
          VALUES (?,?,?,?,?,?,?,?,?,?, 'done')`).run(id, Date.now(), actor, actor_kind, i.tool, summary, JSON.stringify(i.input),
          i.inverse.tool, JSON.stringify(i.inverse.input), w ? JSON.stringify(w) : null);
        say("undo.recorded", { id, actor_kind, tool: i.tool });
        return { id };
      },
    });

    ctx.tool("undo.list", {
      effect: "read",
      description: "What was done on the person's behalf, newest first, with id, actor, tool, summary, state and can_undo. Optional filters.",
      input: { type: "object", properties: { actor_kind: { type: "string", enum: [...KINDS] }, actor: { type: "string" }, since: { type: "number", description: "only rows at or after this time, in ms" }, limit: { type: "integer", description: `default ${LIST_DEFAULT}, at most ${LIST_MAX}` } } },
      examples: [{}, { actor_kind: "assistant", limit: 10 }],
      run: async (i = {}) => {
        const where = [], args = [];
        if (i.actor_kind) { where.push("actor_kind = ?"); args.push(i.actor_kind); }
        if (i.actor) { where.push("actor = ?"); args.push(String(i.actor)); }
        if (typeof i.since === "number") { where.push("at >= ?"); args.push(i.since); }
        const limit = Number.isInteger(i.limit) && i.limit > 0 ? Math.min(i.limit, LIST_MAX) : LIST_DEFAULT;
        const rows = db.prepare(`SELECT * FROM undo_acted ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY at DESC, rowid DESC LIMIT ?`).all(...args, limit);
        return { rows: rows.map(shape) };
      },
    });

    /** @type {Map<string, Promise<any>>} */
    const inflight = new Map();

    ctx.tool("undo.run", {
      effect: "write",
      // The person, and an agent or module for its own rows only (the body checks sameActor); the inverse runs as module:undo, never outward or person-only.
      callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"],
      description: "Undo one recorded action by id, running its declared inverse. A person may undo any row; an agent or module only its own.",
      input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      examples: [{ id: "u_abc" }],
      run: async (i, meta = {}) => {
        const caller = String(meta.caller || "");
        const row = /** @type {any} */ (db.prepare("SELECT * FROM undo_acted WHERE id = ?").get(String(i.id)));
        if (!row) throw fail("not_found", `no recorded action ${i.id}`);
        if (!isPerson(caller) && !sameActor(caller, row.actor)) throw fail("denied", "only the person, or whoever did it, can undo this");
        if (row.state === "undone") return { id: row.id, state: "undone", already: true };
        if (inflight.has(row.id)) { await inflight.get(row.id).catch(() => {}); return { id: row.id, state: "undone", already: true }; }
        const go = (async () => {
          const mark = err => {
            db.prepare("UPDATE undo_acted SET state = 'failed', error = ? WHERE id = ?").run(cap(err, 500), row.id);
            say("undo.failed", { id: row.id });
            throw fail("undo_failed", err);
          };
          const no = refuse(row.inverse_tool);
          if (no) return mark(no);
          // As this module's own caller: see the head of this file.
          let r;
          try { r = await ctx.call(row.inverse_tool, JSON.parse(row.inverse_input)); }
          catch (e) { return mark(/** @type {Error} */ (e).message || "the inverse failed"); }
          if (!r || r.error) return mark((r && r.error && r.error.message) || "the inverse failed");
          db.prepare("UPDATE undo_acted SET state = 'undone', undone_at = ?, undone_by = ?, error = NULL WHERE id = ?").run(Date.now(), caller, row.id);
          say("undo.done", { id: row.id });
          return { id: row.id, state: "undone" };
        })();
        inflight.set(row.id, go);
        try { return await go; } finally { inflight.delete(row.id); }
      },
    });

    return { async stop() { clearInterval(timer); await Promise.allSettled([...inflight.values()]); } };
  },
};
