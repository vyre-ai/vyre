// @ts-check
// goals: a goal and an ordered milestone list, attached to a session or a project (the user's
// decision, 2026-09-28). An agent may propose one; only a person's tap turns it into a real goal
// (goals.accept) - the same shape as team_propose needing a person's team.add. Every read and
// write an agent does (set, milestone-done, get, list) is scoped to its own calling thread or
// that thread's own project - it never proposes into, ticks or reads another project's goal.
// Notifications ride on core/push's existing kinds.goal (goal.milestone, goal.done) - nothing new
// to build there.

import { isPerson } from "../../lib/caller.js";
import { newPrefixedId } from "../../lib/id.js";

export const MIGRATIONS = [
  `
  CREATE TABLE goals_items (
    id TEXT PRIMARY KEY,
    project TEXT,
    thread TEXT,
    goal TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    created_by TEXT,
    milestones TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    accepted_at INTEGER,
    done_at INTEGER
  );
  CREATE INDEX goals_items_project ON goals_items (project);
  CREATE INDEX goals_items_thread ON goals_items (thread);
  `,
];

const STATES = ["pending", "active", "done", "cancelled"];
// Owner surfaces only (reviewer's MEDIUM 1, fixed): checking "does the caller name an agent" and
// treating everything else as the person was backwards - a bare "mcp" caller (a model in the
// person's own session, no agent name at all) and a spoofed "cli" (relabelled "mcp" upstream)
// both read as "person" under that test. isPerson (lib/caller.js) checks the owner surfaces and
// owner devices explicitly instead, and refuses an agent claim first, whatever it otherwise reads
// as (cohesion, 2026-09-28) - every other caller kind, guests and hooks included, is never the
// person either way. This swap is intentionally STRICTER than the local isPerson it replaced, not
// behaviorally identical: "cli agent:kit" and "cli:thread:x" both used to read as the person here
// and no longer do (reviewer, 2026-09-28) - the exact class of caller this file's isPerson was
// already trying to refuse, just not fully.
const PEOPLE = ["cli", "local", "deck", "capsule"];
const AGENTS = ["mcp", "harness", "module"];
const newId = () => newPrefixedId("g");
const refuse = (message, code) => Object.assign(new Error(message), { code });

const shape = r => r && ({ id: r.id, project: r.project ?? null, thread: r.thread ?? null, goal: r.goal, state: r.state,
  created_by: r.created_by ?? null, milestones: JSON.parse(r.milestones), created_at: r.created_at, accepted_at: r.accepted_at ?? null, done_at: r.done_at ?? null });

const str = { type: "string" };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = () => Date.now();

    // Where the rows live. With the kernel on (ctx.kernel, first-party only) new goals are kernel records of type `goal` (kernel/store, the home's own store);
    // goals made before it stay in goals_items and keep working, read and written where they are. With the kernel off nothing about this module changes.
    const K = ctx.kernel;
    const kc = () => K.serviceChain();
    const fromRec = (/** @type {any} */ r) => ({ id: r.id, project: r.data.project ?? null, thread: r.data.thread ?? null, goal: r.data.goal, state: r.data.state, created_by: r.data.created_by ?? null,
      milestones: JSON.parse(r.data.milestones), created_at: r.data.created_at, accepted_at: r.data.accepted_at ?? null, done_at: r.data.done_at ?? null });
    /** @param {any} r */
    const fromRecV = r => Object.defineProperty(fromRec(r), "_version", { value: r.version, enumerable: false });
    /** @param {string} id @returns {Promise<any>} */
    const getK = async id => { try { const r = await K.records.get(kc(), "goal", id); return r ? fromRecV(r) : null; } catch { return null; } };
    const legacyGet = (/** @type {string} */ id) => shape(/** @type {any} */ (db.prepare("SELECT * FROM goals_items WHERE id = ?").get(id)));
    const get = async (/** @type {string} */ id) => (K ? (await getK(id)) || legacyGet(id) : legacyGet(id));
    const must = async (/** @type {string} */ id) => { const g = await get(id); if (!g) throw refuse(`no goal ${id} (goals.list shows them)`, "not_found"); return g; };
    /** Update a goal where it lives. @param {any} g the goal as read @param {Record<string, any>} patch fields of the legacy row shape */
    const update = async (g, patch) => {
      if (K && g._version !== undefined) {
        const data = { ...patch }; if (data.milestones !== undefined) data.milestones = JSON.stringify(data.milestones);
        await K.records.update(kc(), "goal", g.id, data, g._version);
        return;
      }
      const cols = Object.keys(patch);
      db.prepare(`UPDATE goals_items SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map(c => (c === "milestones" ? JSON.stringify(patch[c]) : patch[c])), g.id);
    };

    /** The calling thread's own project, or null (a person's own caller, or a thread with none). */
    const callerProject = async thread => {
      if (!thread) return null;
      const r = await ctx.call("threads.get", { thread });
      return r && r.data && r.data.thread ? r.data.thread.project ?? null : null;
    };

    /** Rule 3 (and the LOW: an agent proposes only in its own scope): a person is always in
     * scope; anyone else only inside the named thread, or their own calling thread's project. A
     * caller with no thread at all (a bare module, an assistant with no session) is in scope of
     * nothing but its own proposals. @param {{ project?: string|null, thread?: string|null }} target
     * @param {{ caller?: string, thread?: string }} meta */
    const inScope = async (target, meta) => {
      if (isPerson(meta && meta.caller)) return true;
      const thread = meta && meta.thread;
      // Reviewer's LOW 2, 2026-09-28: with both a thread and a project named, checking only the
      // thread let an agent tag its own thread with a mismatched project label (goals.set) or read
      // a goal it otherwise owns by thread as if it were also in-scope for an unrelated project.
      // Both must hold: its own thread, AND that thread's own real project (never a project it
      // merely claims alongside a thread it happens to own).
      if (target.thread && target.project) return Boolean(thread) && thread === target.thread && (await callerProject(thread)) === target.project;
      if (target.thread) return Boolean(thread) && thread === target.thread;
      if (target.project) return Boolean(thread) && (await callerProject(thread)) === target.project;
      return true; // neither a thread nor a project named: nobody's in particular
    };

    ctx.tool("goals.set", {
      description: "Set a goal with ordered milestones on a thread or project. A person's call sets it; an agent's is a pending proposal until goals.accept.",
      input: { type: "object", required: ["goal", "milestones"], properties: { project: str, thread: str, goal: str, milestones: { type: "array", items: str, minItems: 1 } } },
      callers: [...PEOPLE, ...AGENTS],
      run: async (i, meta) => {
        if (!i.project && !i.thread) throw refuse("a goal needs a project or a thread", "bad_input");
        const person = isPerson(meta && meta.caller);
        // LOW: an agent proposes only into its own session or project, never another's.
        if (!person && !(await inScope({ project: i.project || null, thread: i.thread || null }, meta))) {
          throw refuse("a goal may only be proposed in the caller's own session or project", "denied");
        }
        const state = person ? "active" : "pending";
        const created_by = person ? "person" : String((meta && meta.caller) || "agent");
        const milestones = i.milestones.map(text => ({ text: String(text), done: false, done_at: null }));
        const at = now();
        let id;
        if (K) {
          const rec = await K.records.create(kc(), "goal", { project: i.project || null, thread: i.thread || null, goal: String(i.goal), state, created_by, milestones: JSON.stringify(milestones), created_at: at, ...(person ? { accepted_at: at } : {}) });
          id = rec.id;
        } else {
          id = newId();
          db.prepare(`INSERT INTO goals_items (id, project, thread, goal, state, created_by, milestones, created_at, accepted_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(id, i.project || null, i.thread || null, String(i.goal), state, created_by, JSON.stringify(milestones), at, person ? at : null);
        }
        const g = await must(id);
        ctx.events.emit(person ? "goal.created" : "goal.proposed", { goal: id }, { project: g.project || undefined, thread: g.thread || undefined });
        return g;
      },
    });

    ctx.tool("goals.accept", {
      description: "Turn a proposed goal (an agent's goals.set) into a real one. The person's own - a model never accepts its own proposal.",
      input: { type: "object", required: ["goal"], properties: { goal: str } },
      callers: PEOPLE,
      run: async i => {
        const g = await must(i.goal);
        if (g.state !== "pending") throw refuse(`${i.goal} is ${g.state}, not pending`, "bad_state");
        await update(g, { state: "active", accepted_at: now() });
        ctx.events.emit("goal.accepted", { goal: i.goal }, { project: g.project || undefined, thread: g.thread || undefined });
        return must(i.goal);
      },
    });

    ctx.tool("goals.milestone-done", {
      description: "Mark a milestone done by its 0-based index. Marks the goal done and emits goal.done when the last lands. Agents only in their own scope.",
      input: { type: "object", required: ["goal", "index"], properties: { goal: str, index: { type: "integer", minimum: 0, description: "0-based." } } },
      callers: [...PEOPLE, ...AGENTS],
      run: async (i, meta) => {
        const g = await must(i.goal);
        if (g.state !== "active") throw refuse(`${i.goal} is ${g.state}, not active`, "bad_state");
        if (!(await inScope(g, meta))) throw refuse(`${i.goal} belongs to another ${g.thread ? "session" : "project"}; call it from there or ask the person`, "denied");
        if (i.index >= g.milestones.length) throw refuse(`${i.goal} has no milestone ${i.index}`, "bad_input");
        if (g.milestones[i.index].done) return g; // already done: no event twice
        const milestones = g.milestones.map((m, idx) => idx === i.index ? { ...m, done: true, done_at: now() } : m);
        const allDone = milestones.every(m => m.done);
        await update(g, { milestones, state: allDone ? "done" : g.state, done_at: allDone ? now() : null });
        const where = { project: g.project || undefined, thread: g.thread || undefined };
        ctx.events.emit("goal.milestone", { goal: i.goal, index: i.index, text: milestones[i.index].text }, where);
        if (allDone) ctx.events.emit("goal.done", { goal: i.goal }, where);
        return must(i.goal);
      },
    });

    ctx.tool("goals.get", {
      description: "One goal by id. An agent reads only a goal in its own session or project.",
      input: { type: "object", required: ["goal"], properties: { goal: str } },
      callers: [...PEOPLE, ...AGENTS],
      run: async (i, meta) => {
        const g = await must(i.goal);
        if (!(await inScope(g, meta))) throw refuse(`${i.goal} belongs to another ${g.thread ? "session" : "project"}; call it from there or ask the person`, "denied");
        return g;
      },
    });

    ctx.tool("goals.list", {
      description: "Goals for a project or thread, newest first. An agent sees only its own scope; a person giving neither sees every goal.",
      input: { type: "object", properties: { project: str, thread: str, state: { type: "string", enum: STATES } } },
      callers: [...PEOPLE, ...AGENTS],
      run: async (i, meta) => {
        // M2: an agent's read is scoped the same way a milestone tick is - never every project's.
        const { project, thread } = i;
        const where = [], args = [];
        if (!isPerson(meta && meta.caller)) {
          const ownProject = await callerProject(meta && meta.thread);
          if (thread !== undefined && thread !== (meta && meta.thread)) throw refuse("an agent reads only its own session's goals", "denied");
          if (project !== undefined && project !== ownProject) throw refuse("an agent reads only its own project's goals", "denied");
          if (thread === undefined && project === undefined) {
            // Neither given: its own scope, project or thread - an OR, never an AND, since a goal
            // has one or the other, and never "every goal here".
            const mine = [];
            if (ownProject) { mine.push("project = ?"); args.push(ownProject); }
            if (meta && meta.thread) { mine.push("thread = ?"); args.push(meta.thread); }
            if (!mine.length) return []; // no session context at all: nothing is its own
            where.push(`(${mine.join(" OR ")})`);
          }
        }
        if (project) { where.push("project = ?"); args.push(project); }
        if (thread) { where.push("thread = ?"); args.push(thread); }
        if (i.state) { where.push("state = ?"); args.push(i.state); }
        const sql = `SELECT * FROM goals_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 200`;
        const legacy = /** @type {any[]} */ (db.prepare(sql).all(...args)).map(shape);
        if (!K) return legacy;
        // The same filter over the kernel's goal records, merged newest first with the goals made before the kernel was on.
        const parts = [];
        if (!isPerson(meta && meta.caller) && thread === undefined && project === undefined) {
          const ownProject = await callerProject(meta && meta.thread);
          const mine = [];
          if (ownProject) mine.push({ field: "project", op: "eq", value: ownProject });
          if (meta && meta.thread) mine.push({ field: "thread", op: "eq", value: meta.thread });
          parts.push({ or: mine });
        }
        if (project) parts.push({ field: "project", op: "eq", value: project });
        if (thread) parts.push({ field: "thread", op: "eq", value: thread });
        if (i.state) parts.push({ field: "state", op: "eq", value: i.state });
        const page = await K.records.query(kc(), "goal", { ...(parts.length ? { filter: { and: parts } } : {}), page: { limit: 200 } });
        return [...legacy, ...page.rows.map(fromRec)].sort((a, b) => b.created_at - a.created_at).slice(0, 200).map(({ _version, ...g }) => g);
      },
    });

    return { async stop() {} };
  },
};
