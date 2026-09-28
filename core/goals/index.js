// @ts-check
// goals: a goal and an ordered milestone list, attached to a session or a project (the user's
// decision, 2026-09-28). An agent may propose one; only a person's tap turns it into a real goal
// (goals.accept) - the same shape as team_propose needing a person's team.add. Milestones are
// ticked off with goals.milestone-done, scoped to the goal's own session or project: an agent
// working somewhere else cannot tick another project's goal. Notifications ride on core/push's
// existing kinds.goal (goal.milestone, goal.done) - nothing new to build there.

import crypto from "node:crypto";

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
/** A caller that names an agent: "mcp:agent:kit", "harness:agent:kit" (same shape as core/planner's AGENT_CLAIM). */
const isAgent = caller => /(?:^|[\s:])agent:/.test(String(caller || ""));
const newId = () => `g_${crypto.randomBytes(6).toString("base64url")}`;
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

    const get = id => shape(/** @type {any} */ (db.prepare("SELECT * FROM goals_items WHERE id = ?").get(id)));
    const must = id => { const g = get(id); if (!g) throw refuse(`no goal ${id}`, "not_found"); return g; };

    /** The calling thread's own project, or null (a person's own caller, or a thread with none). */
    const callerProject = async thread => {
      if (!thread) return null;
      const r = await ctx.call("threads.get", { thread });
      return r && r.data && r.data.thread ? r.data.thread.project ?? null : null;
    };

    /** Rule 3: a person may always tick a milestone; an agent only inside the goal's own thread
     * or project. @param {any} g @param {{ caller?: string, thread?: string }} meta */
    const inScope = async (g, meta) => {
      if (!isAgent(meta && meta.caller)) return true;
      const thread = meta && meta.thread;
      if (g.thread) return thread === g.thread;
      if (g.project) return (await callerProject(thread)) === g.project;
      return true; // a goal with neither is nobody's in particular
    };

    ctx.tool("goals.set", {
      description: "Set a goal with its ordered milestones, on a session or a project (at least one of thread, project). A person's own call is the goal at once; an agent's is a proposal (state pending) until goals.accept.",
      input: { type: "object", required: ["goal", "milestones"], properties: { project: str, thread: str, goal: str, milestones: { type: "array", items: str, minItems: 1 } } },
      run: async (i, meta) => {
        if (!i.project && !i.thread) throw refuse("a goal needs a project or a thread", "bad_input");
        const id = newId();
        const person = !isAgent(meta && meta.caller);
        const state = person ? "active" : "pending";
        const created_by = person ? "person" : String((meta && meta.caller) || "agent");
        const milestones = i.milestones.map(text => ({ text: String(text), done: false, done_at: null }));
        const at = now();
        db.prepare(`INSERT INTO goals_items (id, project, thread, goal, state, created_by, milestones, created_at, accepted_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(id, i.project || null, i.thread || null, String(i.goal), state, created_by, JSON.stringify(milestones), at, person ? at : null);
        const g = must(id);
        ctx.events.emit(person ? "goal.created" : "goal.proposed", { goal: id }, { project: g.project || undefined, thread: g.thread || undefined });
        return g;
      },
    });

    ctx.tool("goals.accept", {
      description: "Turn a proposed goal (an agent's goals.set) into a real one. The person's own - a model never accepts its own proposal.",
      input: { type: "object", required: ["goal"], properties: { goal: str } },
      run: async i => {
        const g = must(i.goal);
        if (g.state !== "pending") throw refuse(`${i.goal} is ${g.state}, not pending`, "bad_state");
        db.prepare("UPDATE goals_items SET state = 'active', accepted_at = ? WHERE id = ?").run(now(), i.goal);
        ctx.events.emit("goal.accepted", { goal: i.goal }, { project: g.project || undefined, thread: g.thread || undefined });
        return must(i.goal);
      },
    });

    ctx.tool("goals.milestone-done", {
      description: "Mark a milestone done, by its index (0-based). Scoped to the goal's own session or project - an agent elsewhere is refused. Marks the goal itself done, and emits goal.done, when the last one lands.",
      input: { type: "object", required: ["goal", "index"], properties: { goal: str, index: { type: "integer", minimum: 0 } } },
      run: async (i, meta) => {
        const g = must(i.goal);
        if (g.state !== "active") throw refuse(`${i.goal} is ${g.state}, not active`, "bad_state");
        if (!(await inScope(g, meta))) throw refuse(`${i.goal} belongs to another ${g.thread ? "session" : "project"}`, "denied");
        if (i.index >= g.milestones.length) throw refuse(`${i.goal} has no milestone ${i.index}`, "bad_input");
        if (g.milestones[i.index].done) return g; // already done: no event twice
        const milestones = g.milestones.map((m, idx) => idx === i.index ? { ...m, done: true, done_at: now() } : m);
        const allDone = milestones.every(m => m.done);
        db.prepare(`UPDATE goals_items SET milestones = ?, state = ?, done_at = ? WHERE id = ?`)
          .run(JSON.stringify(milestones), allDone ? "done" : g.state, allDone ? now() : null, i.goal);
        const where = { project: g.project || undefined, thread: g.thread || undefined };
        ctx.events.emit("goal.milestone", { goal: i.goal, index: i.index, text: milestones[i.index].text }, where);
        if (allDone) ctx.events.emit("goal.done", { goal: i.goal }, where);
        return must(i.goal);
      },
    });

    ctx.tool("goals.get", {
      description: "One goal by id.",
      input: { type: "object", required: ["goal"], properties: { goal: str } },
      run: async i => must(i.goal),
    });

    ctx.tool("goals.list", {
      description: "Goals for a project or a thread (or every one, with neither), newest first.",
      input: { type: "object", properties: { project: str, thread: str, state: { type: "string", enum: STATES } } },
      run: async i => {
        const where = [], args = [];
        if (i.project) { where.push("project = ?"); args.push(i.project); }
        if (i.thread) { where.push("thread = ?"); args.push(i.thread); }
        if (i.state) { where.push("state = ?"); args.push(i.state); }
        const sql = `SELECT * FROM goals_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 200`;
        return /** @type {any[]} */ (db.prepare(sql).all(...args)).map(shape);
      },
    });

    return { async stop() {} };
  },
};
