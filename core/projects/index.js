// @ts-check
// The projects module: the tools over ./projects.js. Recall and Memory are used through
// ctx.call and are not listed under requires, because projects must still start, list and
// brief without them; it only searches less and says so.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Projects, MIGRATIONS } from "./projects.js";
import { label } from "./brief.js";
import { moveProjects, RECORD } from "./move.js";
import { boxProjectsDir, oldProjectsDir, workDir, home as vyreHome } from "../config/index.js";
import { wantsMacs, askMacs, mergeRows, sourcesOf, boxLabel, macLabel } from "../modules/federate.js";
import { isProjectId } from "../../lib/project-id.js";

const str = { type: "string" };
const strs = { type: "array", items: str };
const person = { type: "object", properties: { name: str, email: str } };
/** On the box, "all" takes in the paired Macs' rows too (the default for the person), "local" only the box's. */
const machines = { type: "string", enum: ["all", "local"] };
/** The catalogue's own order across machines: title matches, then how often it was said, then newest. */
const byCatalog = (a, b) => Number(Boolean(b.titled)) - Number(Boolean(a.titled)) || (b.said || 0) - (a.said || 0) || (b.last || 0) - (a.last || 0);

/**
 * A project's threads with its missing picks filled in from the Macs' recall.sessions answers:
 * name, title, folder and times from the Mac, labelled with it. Every other row is the box's and
 * labelled so; a pick no machine answered for stays as it was, missing, with no label. Newest
 * first, missing picks last, as threadsOf orders them.
 * @param {any} ctx @param {any[]} rows @param {Array<{ name: string, ok: boolean, data?: any }>} answers
 */
function resolvePicks(ctx, rows, answers) {
  /** @type {Map<string, any>} */
  const found = new Map();
  for (const a of answers) if (a.ok && Array.isArray(a.data)) for (const s of a.data) if (s && s.id && !found.has(s.id)) found.set(s.id, { s, where: macLabel(a) });
  const out = rows.map(t => {
    if (!t.missing) return { ...t, ...boxLabel(ctx) };
    const f = found.get(t.id);
    if (!f) return t;
    const s = f.s;
    const row = { ...t, name: s.name || null, title: s.title || null, cwd: s.cwd || null, started: Number(s.started) || 0,
      last: Number(s.ended) || 0, turns: Number(s.turns) || 0, human: Number(s.human) === 1 || s.human === true, missing: false };
    return { ...row, label: label(row), ...f.where };
  });
  return out.sort((a, b) => Number(Boolean(a.missing)) - Number(Boolean(b.missing)) || (b.last || 0) - (a.last || 0));
}

/**
 * The catalogue with live on each session: true when a terminal has it open now, from the
 * Switchboard's binds. Without the Switchboard every row says false.
 * @param {any} ctx @param {{ sessions: any[] }} cat
 */
export async function withLive(ctx, cat) {
  const r = await ctx.call("threads.live", {}).catch(() => null);
  const live = new Set(r && r.data && Array.isArray(r.data.sessions) ? r.data.sessions : []);
  return { ...cat, sessions: cat.sessions.map(s => ({ ...s, live: live.has(s.id) })) };
}
/** The person's own surfaces. The loader refuses every other caller (agents' MCP, models' harness, guests, modules). */
const OWNER = ["cli", "local", "capsule", "deck"];
/** A caller that names an agent ("cli:agent:kit"): the same test as drive's and glass's. */
const isAgent = (/** @type {any} */ caller) => /(?:^|[\s:])agent:/.test(String(caller || ""));
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    // projects_access (table itself is step 1 of MIGRATIONS, in projects.js — reviewer's MEDIUM:
    // core/store's migrate() numbers steps by array index, so appending it here instead would
    // collide with whatever step another team adds to this same array next) is which agent may
    // reach a project's data at all: Drive, sync and anything else that serves a project's files
    // or sessions to an agent asks this, through ctx.call (federation's Vyre Drive step 3).
    ctx.store.migrate(MIGRATIONS);
    const P = new Projects({
      db: ctx.store.db, config: ctx.config, call: ctx.call,
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
    });
    // Only markers already known are read at start. Walking the roots waits for the first list
    // or create, so starting vyred never crawls the user's folders unasked.
    try { P.refresh(); } catch (e) { ctx.log("could not read project markers: " + /** @type {Error} */ (e).message); }

    ctx.tool("projects.list", {
      description: "Every project: name, home, folders, people, how many threads are in it (picked or by folder), the picked thread ids (picks), newest activity first.",
      input: { type: "object", properties: { machines } },
      run: async (input, { caller } = {}) => {
        if (!wantsMacs(ctx, input, caller)) return P.list();
        // On the box, for the person: the box's projects, then each Mac's, every one labelled.
        const [own, answers] = await Promise.all([P.list(), askMacs(ctx, "projects.list", {})]);
        return { ...own, projects: mergeRows(ctx, own.projects, answers, { rows: d => d && d.projects }),
          problems: mergeRows(ctx, own.problems, answers, { rows: d => d && d.problems }), sources: sourcesOf(ctx, answers) };
      },
    });
    ctx.tool("projects.create", {
      description: "Make a project by hand: a name, a home folder (default: a new folder in the projects folder), other folders it owns, the threads picked into it, and its people.",
      input: { type: "object", required: ["name"], properties: { name: str, home: str, org: str, workspaces: strs, threads: strs, people: { type: "array", items: person }, watchers: strs } },
      run: async input => P.create(input),
    });
    ctx.tool("projects.add-threads", {
      description: "Pick threads (Claude Code session ids) into a project. A thread can be in several projects.",
      input: { type: "object", required: ["project", "threads"], properties: { project: str, threads: strs } },
      run: async ({ project, threads }) => P.addThreads(project, threads),
    });
    ctx.tool("projects.remove-threads", {
      description: "Remove picks from a project. Threads that ran in the project's folders stay in it by folder, and are listed.",
      input: { type: "object", required: ["project", "threads"], properties: { project: str, threads: strs } },
      run: async ({ project, threads }) => P.removeThreads(project, threads),
    });
    ctx.tool("projects.catalog", {
      description: "Every session on this device for picking into projects, with its /rename name, first message, folder, last activity, projects, and live (a terminal has it open now). q searches names, first messages, folders and, through Recall, what was said.",
      input: { type: "object", properties: { q: str, limit: { type: "integer" }, human: { type: "boolean" }, machines } },
      run: async (input, { caller } = {}) => {
        const { machines: _, ...own } = input;
        if (!wantsMacs(ctx, input, caller)) return withLive(ctx, await P.catalog(own));
        // On the box, for the person: every Mac's sessions too, in one list in the catalogue's
        // order, capped at the limit. total counts every machine; sources says who answered, and
        // each one's own total.
        const [here, answers] = await Promise.all([P.catalog(own).then(c => withLive(ctx, c)), askMacs(ctx, "projects.catalog", own)]);
        const total = answers.reduce((n, a) => n + (a.ok && a.data ? Number(a.data.total) || 0 : 0), here.total);
        const sessions = mergeRows(ctx, here.sessions, answers, { rows: d => d && d.sessions, compare: byCatalog, limit: own.limit ?? 50 });
        const totals = [here.total, ...answers.map(a => (a.ok && a.data ? Number(a.data.total) || 0 : undefined))];
        const sources = sourcesOf(ctx, answers).map((x, i) => (totals[i] === undefined ? x : { ...x, total: totals[i] }));
        return { ...here, total, sessions, sources };
      },
    });
    ctx.tool("projects.of", {
      description: "The project that owns a folder or any folder under it, or null. slug is what the other tools take.",
      input: { type: "object", required: ["cwd"], properties: { cwd: str } },
      run: async ({ cwd }) => { const p = P.of(cwd); return p ? { slug: p.slug, name: p.name, home: p.home, folders: p.workspaces } : null; },
    });
    ctx.tool("projects.threads", {
      description: "The threads in a project, newest first, each saying whether it was picked or ran in the project's folders.",
      input: { type: "object", required: ["project"], properties: { project: str, limit: { type: "integer" }, machines } },
      run: async (input, { caller } = {}) => {
        const { project, limit = 100 } = input;
        P.refresh();
        const rows = P.threadsOf(P.resolve(project));
        if (!wantsMacs(ctx, input, caller)) return rows.slice(0, limit);
        // On the box, for the person: a pick the box has no session for may be a Mac session
        // picked from the Deck. The Macs are asked once, for those ids only, and what they have
        // comes back labelled and is never stored here. A pick no machine has stays missing.
        const ids = rows.filter(t => t.missing).map(t => t.id);
        const answers = ids.length ? await askMacs(ctx, "recall.sessions", { ids, limit: ids.length }) : [];
        return resolvePicks(ctx, rows, answers).slice(0, limit);
      },
    });
    ctx.tool("projects.context", {
      description: "The brief for a thread starting in a project, as plain text for Claude: what the project is, its people, its other threads and its memory. Give project, or cwd and session as a SessionStart hook sees them.",
      input: { type: "object", properties: { project: str, cwd: str, session: str } },
      run: async input => P.context(input),
    });
    ctx.tool("projects.move", {
      description: "Box only, the owner only: move the project homes from ~/Vyre/projects to /work/projects, leaving a link at each old folder and rewriting the rows and markers. dry: true (do this first) answers what would move, what would be skipped and why, and the rewrites, and changes nothing. A real move runs once, only while VYRE_PROJECTS_MOVE=1 or config projects.move is \"enabled\", and answers restart: true: vyred uses /work/projects after a restart.",
      input: { type: "object", properties: { dry: { type: "boolean" } } },
      callers: OWNER,
      run: async ({ dry = false } = {}, meta = {}) => {
        if ((meta && meta.agent) || isAgent(meta && meta.caller)) throw refuse("an agent cannot move the projects folder; that is for the owner", "denied");
        if (ctx.config.role !== "box") throw refuse("projects.move is for a box; a Mac keeps its projects where they are", "not_box");
        const root = ctx.paths ? ctx.paths.root : vyreHome();
        const from = oldProjectsDir(), to = boxProjectsDir();
        const record = path.join(root, RECORD);
        let done = null;
        try { done = JSON.parse(fs.readFileSync(record, "utf8")); } catch {}
        if (done) {
          if (dry) return { dry: true, done: true, ...done, next: `already moved; the record is ${record}` };
          throw refuse(`the projects were already moved (${record})`, "already_moved");
        }
        let work = false;
        try { work = fs.statSync(workDir()).isDirectory(); } catch {}
        if (!work) throw refuse(`this box has no work folder (${workDir()}), so there is nowhere to move the projects to`, "no_work_folder");
        const on = process.env.VYRE_PROJECTS_MOVE === "1" || (ctx.config.projects && ctx.config.projects.move === "enabled");
        if (!dry && !on) throw refuse("the move is off until box-deploy validates it on a copy of this box; run it with dry: true to see what it would do", "move_off");
        const out = moveProjects({ db: ctx.store.db, from, to, root, dryRun: dry,
          log: m => ctx.log(m), emit: (type, payload) => ctx.events.emit(type, payload) });
        if (!out) return { dry, from, to, moved: [], skipped: [], rewrites: [], next: `nothing to move: ${from} is not a folder, or is ${to} itself` };
        if (dry) return { dry: true, ...out };
        P.refresh();
        return { dry: false, ...out, restart: true, next: `Restart vyred: the projects folder is now ${to}` };
      },
    });

    // projects.access: deny by default. An empty agent grants every agent; a named agent's own
    // row, when there is one, wins over the wildcard for that agent (team-lead's decision, Vyre
    // Drive step 3). Granting needs the owner's presence (HUMAN_ONLY, core/presence/index.js):
    // the same weight a vault grant to an agent carries; revoking is instant (PERSON_ONLY), so
    // taking access away is never held up behind a Touch ID prompt.
    const db = ctx.store.db;
    const accessRow = (project, agent) => {
      const own = /** @type {any} */ (db.prepare("SELECT * FROM projects_access WHERE project = ? AND agent = ?").get(project, String(agent || "")));
      if (own) return own;
      if (agent) return /** @type {any} */ (db.prepare("SELECT * FROM projects_access WHERE project = ? AND agent = ?").get(project, ""));
      return null;
    };
    const setAccess = (project, agent, status, by) => {
      const slug = P.resolve(project).slug;
      const a = String(agent || "");
      // ON CONFLICT keeps the existing row's id (never in the SET clause); the id supplied here
      // is only ever used for a genuinely new row.
      db.prepare(`INSERT INTO projects_access (id, project, agent, status, by, at) VALUES (?,?,?,?,?,?)
        ON CONFLICT (project, agent) DO UPDATE SET status = excluded.status, by = excluded.by, at = excluded.at`)
        .run(crypto.randomUUID(), slug, a, status, by, Date.now());
      return { project: slug, agent: a, status };
    };

    ctx.tool("projects.access.grant", {
      description: "Let an agent reach a project's data (Drive, synced sessions, anything project-scoped asks projects.access.check before serving an agent). agent left out or empty grants every agent. Needs the owner's presence, the same weight a vault grant to an agent carries: Drive and sync refuse an ungranted project's data outright, they do not merely leave it off a list.",
      input: { type: "object", required: ["project"], properties: { project: str, agent: str } },
      callers: OWNER,
      run: async ({ project, agent }, meta = {}) => setAccess(project, agent, "granted", String((meta && meta.caller) || "unknown")),
    });
    ctx.tool("projects.access.revoke", {
      description: "Take an agent's (or, agent left out, every agent's) access to a project away. Instant, no presence needed: taking access away is never held up behind a prompt.",
      input: { type: "object", required: ["project"], properties: { project: str, agent: str } },
      callers: OWNER,
      run: async ({ project, agent }, meta = {}) => setAccess(project, agent, "revoked", String((meta && meta.caller) || "unknown")),
    });
    ctx.tool("projects.access.check", {
      description: "Whether a named agent may reach a project's data: deny by default, an agent-specific grant wins over the wildcard grant (a grant or revoke that left agent out, covering everyone). Drive, sync and anything else that serves a project's files or sessions to an agent asks this first. Internal to first-party modules and the owner's own surfaces; a model never asks this on its own behalf to learn what exists: the row it wants is simply left out of a listing instead. agent is required (reviewer's LOW): an empty agent would otherwise read the wildcard row directly, conflating 'no agent specified' with 'the wildcard grant', two different things.",
      input: { type: "object", required: ["project", "agent"], properties: { project: str, agent: str } },
      callers: ["module", "cli", "local", "deck", "capsule"],
      run: async ({ project, agent }) => {
        if (!isProjectId(project)) return { project, agent: String(agent || ""), granted: false };
        const row = accessRow(project, agent);
        return row ? { project, agent: String(agent || ""), granted: row.status === "granted", status: row.status, by: row.by, at: row.at }
          : { project, agent: String(agent || ""), granted: false };
      },
    });
    ctx.tool("projects.access.list", {
      description: "Every grant and revoke on record, for a project or every project, newest first, for the owner to review who can reach what.",
      input: { type: "object", properties: { project: str } },
      callers: OWNER,
      run: async ({ project }) => {
        const rows = project
          ? db.prepare("SELECT project, agent, status, by, at FROM projects_access WHERE project = ? ORDER BY at DESC").all(P.resolve(project).slug)
          : db.prepare("SELECT project, agent, status, by, at FROM projects_access ORDER BY at DESC").all();
        return { grants: rows };
      },
    });

    ctx.tool("projects.access.migrate", {
      description: "One-time bootstrap for projects.access (Vyre Drive step 3, one source of truth): seeds a granted row for every agent's own agents.projects entry that has none yet, so an agent already scoped to a project by agents.create/update keeps reading it once memory's guard starts checking projects.access too. Never overwrites a person's own revoke: only inserts a row where none exists. \"*\"-projects agents (the assistant included) are untouched here; what they see is the assistant rule, not a per-project grant. Safe to run more than once: later runs add only what a newer agent needs.",
      input: { type: "object", properties: {} },
      callers: OWNER,
      run: async () => {
        const r = await ctx.call("agents.list", {});
        if (r.error) throw refuse(`agents cannot be listed (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`, "no_link");
        const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
        let seeded = 0;
        const projects = P.valid();
        for (const a of list) {
          if (!a || !a.name || a.projects === "*" || !Array.isArray(a.projects)) continue;
          for (const ref of a.projects) {
            const p = projects.find(x => x.slug === String(ref) || x.name.toLowerCase() === String(ref).toLowerCase());
            if (!p) continue; // an agent may name a project that moved or was removed; nothing to seed for it
            const before = db.prepare("SELECT 1 FROM projects_access WHERE project = ? AND agent = ?").get(p.slug, a.name);
            if (before) continue;
            db.prepare("INSERT INTO projects_access (id, project, agent, status, by, at) VALUES (?,?,?,?,?,?)")
              .run(crypto.randomUUID(), p.slug, a.name, "granted", "projects.access.migrate", Date.now());
            seeded++;
          }
        }
        return { seeded };
      },
    });

    return { async stop() {} };
  },
};
