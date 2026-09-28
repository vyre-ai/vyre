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
import { ownerDevice } from "../modules/index.js";

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
// Reviewer's MEDIUM 2 on f8330ccc: callers: ["module"] alone lets ANY module reach these three,
// third-party ones installed into the modules folder included — modules skip presence entirely,
// so an installed module could grant an agent any project, or clear a person's explicit revokes
// (clear deletes them outright; a wildcard grant then re-applies as if they never happened).
// Only agents (option (a)'s own sync) and this module itself (projects.create's own wildcard
// grant) may reach them this way; everyone else keeps the owner-plus-presence door above.
const MODULE_ALLOWED = new Set(["module:agents", "module:projects"]);
const moduleOK = meta => MODULE_ALLOWED.has(String((meta && meta.caller) || ""));
// Reviewer's MEDIUM on 7021d4e1: projects.create had no callers at all (open to an agent's own
// MCP, a guest, a hook — anything), so an agent could map any folder into a brand-new project
// and, through f8330ccc's own auto-grant, walk straight in with projects.access on it (a
// never-unmapped folder became a mapped one at the agent's own request). The loader-level
// callers list below closes that (OWNER, plus module callers only); this narrows further, to
// the one module that has any business proposing a folder-to-project mapping on its own: sync's
// attachMapped (core/sync/index.js), which calls exactly these two tools the first time a
// synced folder's confirmed mapping actually lands a file (create when the confirmed slug is
// new, add-workspace when the project already exists).
const SYNC_ALLOWED = new Set(["module:sync"]);
const syncOK = meta => SYNC_ALLOWED.has(String((meta && meta.caller) || ""));
const moduleCallerRefusal = (meta, tool) => {
  const caller = String((meta && meta.caller) || "");
  if (caller.startsWith("module:") && !syncOK(meta)) {
    throw refuse(`${tool} is the person's own door plus sync's proposed mapping, not ${caller}'s`, "denied");
  }
};
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
      description: "Make a project by hand: a name, a home folder (default: a new folder in the projects folder), other folders it owns, the threads picked into it, and its people. Every projects: \"*\" agent (never the assistant, whose \"*\" is a different rule) is granted projects.access on it at once too, option (a) (the lead's decision, so agents.projects and projects.access never drift apart): a wildcard agent reads a brand-new project the moment it exists, with no separate step. callers is the person's own surfaces plus sync's own door (module:sync), for its consent flow's proposed folder-to-project mapping; every other module is refused.",
      input: { type: "object", required: ["name"], properties: { name: str, home: str, org: str, workspaces: strs, threads: strs, people: { type: "array", items: person }, watchers: strs } },
      callers: [...OWNER, "module"],
      run: async (input, meta = {}) => {
        moduleCallerRefusal(meta, "projects.create");
        const created = P.create(input);
        const r = await ctx.call("agents.list", {});
        if (!r.error) {
          const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
          for (const a of list) {
            if (!a || !a.name || a.kind === "assistant" || a.projects !== "*") continue;
            // A brand-new project can never already have a projects.access row (grant/revoke
            // both require it to exist first), so there is nothing here to weigh against a
            // person's own earlier revoke: always safe to grant outright.
            const g = await ctx.call("projects.access.grant", { project: created.slug, agent: a.name });
            if (g.error) throw new Error(`${created.slug} was created, but could not grant ${a.name} access to it: ${g.error.message}`);
          }
        }
        return created;
      },
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
    ctx.tool("projects.watchers.add", {
      description: "Add watchers to a project: names of people who should hear about its Needs (asks, drafts, merges) without running a session in it. Person-only.",
      input: { type: "object", required: ["project", "watchers"], properties: { project: str, watchers: strs } },
      callers: OWNER,
      run: async ({ project, watchers }) => P.addWatchers(project, watchers),
    });
    ctx.tool("projects.watchers.remove", {
      description: "Remove watchers from a project. Person-only.",
      input: { type: "object", required: ["project", "watchers"], properties: { project: str, watchers: strs } },
      callers: OWNER,
      run: async ({ project, watchers }) => P.removeWatchers(project, watchers),
    });
    ctx.tool("projects.add-workspace", {
      description: "Attach an existing folder to an existing project as one of its workspaces (Vyre Drive step 4): the folder starts counting as the project's own, the same as one listed at projects.create time. For confirming sync.consent's proposed folder-to-project mapping, or attaching any other folder by hand. Person-only, instant, no presence: a placement decision, same weight as a pick. Refuses a project that does not exist; a folder that resolves to the project's own home is a no-op (added: null), not an error. callers is the person's own surfaces plus sync's own door (module:sync), the same named exception as projects.create; every other module is refused.",
      input: { type: "object", required: ["project", "folder"], properties: { project: str, folder: str } },
      callers: [...OWNER, "module"],
      run: async ({ project, folder }, meta = {}) => {
        moduleCallerRefusal(meta, "projects.add-workspace");
        return P.addWorkspace(project, folder);
      },
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
    // Agent names are case-insensitive here (team-lead's call, reviewer's LOW): a grant to "Kit"
    // must reach agent "kit". Normalised on every write and every read against this table, so
    // the row's own stored case is whatever the first write happened to use, but the lookup
    // never cares. agents.list's own name is the source of truth for an agent's real casing;
    // this table only ever compares, never displays, so lower-casing here loses nothing.
    const normAgent = agent => String(agent || "").toLowerCase();
    const accessRow = (project, agent) => {
      const a = normAgent(agent);
      const own = /** @type {any} */ (db.prepare("SELECT * FROM projects_access WHERE project = ? AND agent = ?").get(project, a));
      if (own) return own;
      if (a) return /** @type {any} */ (db.prepare("SELECT * FROM projects_access WHERE project = ? AND agent = ?").get(project, ""));
      return null;
    };
    const setAccess = (project, agent, status, by) => {
      const slug = P.resolve(project).slug;
      const a = normAgent(agent);
      // ON CONFLICT keeps the existing row's id (never in the SET clause); the id supplied here
      // is only ever used for a genuinely new row.
      db.prepare(`INSERT INTO projects_access (id, project, agent, status, by, at) VALUES (?,?,?,?,?,?)
        ON CONFLICT (project, agent) DO UPDATE SET status = excluded.status, by = excluded.by, at = excluded.at`)
        .run(crypto.randomUUID(), slug, a, status, by, Date.now());
      return { project: slug, agent: a, status };
    };

    ctx.tool("projects.access.grant", {
      description: "Let an agent reach a project's data (Drive, synced sessions, anything project-scoped asks projects.access.check before serving an agent). agent left out or empty grants every agent. Needs the owner's presence, the same weight a vault grant to an agent carries: Drive and sync refuse an ungranted project's data outright, they do not merely leave it off a list. callers includes \"module\": agents.create/update and projects.create write this grant internally, as part of the person's own already-gated action (option (a), the lead's decision), never reachable this way by a model, since only the loader itself can set a \"module:<name>\" caller.",
      input: { type: "object", required: ["project"], properties: { project: str, agent: str } },
      callers: [...OWNER, "module"],
      run: async ({ project, agent }, meta = {}) => {
        if (String((meta && meta.caller) || "").startsWith("module:") && !moduleOK(meta)) {
          throw refuse(`projects.access.grant is agents' and this module's own internal door, not ${meta.caller}'s`, "denied");
        }
        return setAccess(project, agent, "granted", String((meta && meta.caller) || "unknown"));
      },
    });
    ctx.tool("projects.access.revoke", {
      description: "Take an agent's (or, agent left out, every agent's) access to a project away. Instant, no presence needed: taking access away is never held up behind a prompt. callers includes \"module\": agents.update revokes internally when a project drops off an agent's own list, and only agents' or this module's own internal calls (module:agents, module:projects), never any other installed module.",
      input: { type: "object", required: ["project"], properties: { project: str, agent: str } },
      callers: [...OWNER, "module"],
      run: async ({ project, agent }, meta = {}) => {
        if (String((meta && meta.caller) || "").startsWith("module:") && !moduleOK(meta)) {
          throw refuse(`projects.access.revoke is agents' and this module's own internal door, not ${meta.caller}'s`, "denied");
        }
        return setAccess(project, agent, "revoked", String((meta && meta.caller) || "unknown"));
      },
    });
    ctx.tool("projects.access.clear", {
      description: "Delete every projects.access row for one agent outright, not merely revoke: for agents.delete's own case, where the agent no longer exists at all, so there is nothing left for a future re-add to distinguish from a person's own explicit revoke. Internal: agents' own door alone (module:agents), never any other module, a person or a model.",
      input: { type: "object", required: ["agent"], properties: { agent: str } },
      callers: ["module"],
      run: async ({ agent }, meta = {}) => {
        if (!moduleOK(meta)) throw refuse(`projects.access.clear is agents' own internal door, not ${meta && meta.caller}'s`, "denied");
        const a = normAgent(agent);
        const info = db.prepare("DELETE FROM projects_access WHERE agent = ?").run(a);
        return { agent: a, cleared: info.changes };
      },
    });
    ctx.tool("projects.access.check", {
      description: "Whether a named agent may reach a project's data: deny by default, an agent-specific grant wins over the wildcard grant (a grant or revoke that left agent out, covering everyone). Drive, sync and anything else that serves a project's files or sessions to an agent asks this first. Internal to first-party modules and the owner's own surfaces; a model never asks this on its own behalf to learn what exists: the row it wants is simply left out of a listing instead. agent is required (reviewer's LOW): an empty agent would otherwise read the wildcard row directly, conflating 'no agent specified' with 'the wildcard grant', two different things.",
      input: { type: "object", required: ["project", "agent"], properties: { project: str, agent: str } },
      callers: ["module", "cli", "local", "deck", "capsule"],
      run: async ({ project, agent }) => {
        // reviewer's LOW, still open after `required`: that only rejects a missing key, and
        // `{ agent: "" }` still passes it. accessRow's own first query then matches agent = ''
        // directly, which IS the wildcard row's key, so an empty agent read it as if it were
        // its own row rather than "no agent". Refused here, before accessRow ever runs.
        const a = normAgent(agent);
        if (!a) return { project, agent: "", granted: false };
        if (!isProjectId(project)) return { project, agent: a, granted: false };
        const row = accessRow(project, a);
        return row ? { project, agent: a, granted: row.status === "granted", status: row.status, by: row.by, at: row.at }
          : { project, agent: a, granted: false };
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

    // Cohesion's one-system audit (28 Sep 2026): core/memory, core/recall and core/files each
    // grew their own copy of "which projects may this caller reach", and drifted (memory's never
    // intersected agents.projects with projects.access at all; files' treated any unnamed caller
    // as the owner). projects.reach is the one door now: this module owns projects.access, so
    // the ctx.call fan-out (agents.list, projects.list, projects.access.check) belongs in one
    // place, not three. Landed with one fix on cohesion's own proposal (flagged to them first):
    // the assistant is never checked against projects.access at all (a different privilege tier,
    // not the wildcard agent's own per-project door — THE assistant rule, team-lead, restated
    // twice), so it skips the projects.access.check loop entirely rather than running through it
    // with every project as its candidate set.
    const REACH_OWNER = new Set(["deck", "cli", "local", "capsule"]);
    const reachOwner = c => REACH_OWNER.has(String(c)) || String(c || "").startsWith("module:");
    const reachOwnSession = c => /^mcp(?::thread:[A-Za-z0-9_-]+)?$/.test(String(c || ""));
    const reachAgentOf = c => /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/.exec(String(c || ""))?.[1] || null;
    ctx.tool("projects.reach", {
      description: "Which projects (and their folders) a caller may reach: the one door core/memory, core/recall and core/files all ask instead of keeping their own copy of this check. caller is the ORIGINAL caller the asking module itself received (ctx.call always relabels the actual meta.caller \"module:<name>\", so the owner-vs-refused decision below has to be told this explicitly rather than reading it off the call the registry sees); trusted because only a first-party module can reach this tool at all, and that module is the one responsible for forwarding it faithfully. { all: true } for the true owner (its own surfaces, a module, its own session, or an owner device): no restriction. Otherwise { all: false, agent, projects: [{slug, name, folders, threads}] }, deny by default. kind \"facts\" additionally gives the assistant { all: true } too (personal facts, distilled, not raw content); kind \"content\" (the default) never does, even for the assistant, which instead gets every project that exists, unconditional and never checked against projects.access (a different privilege tier from a projects: \"*\" agent, which is checked). A model never asks this on its own behalf: it cannot, callers being module-only.",
      input: { type: "object", properties: { agent: str, caller: str, kind: { type: "string", enum: ["facts", "content"] } } },
      callers: ["module"],
      run: async ({ agent, caller, kind = "content" }) => {
        const said = reachAgentOf(caller);
        if (said && agent && said !== agent) throw refuse(`the call came from agent ${said} but names agent ${agent}`, "denied");
        const who = said || agent || null;
        if (!who) {
          if (reachOwner(caller) || reachOwnSession(caller) || ownerDevice(caller)) return { all: true, agent: null };
          throw refuse(`refused for ${String(caller || "an unnamed caller").slice(0, 60)}`, "denied");
        }
        const r = await ctx.call("agents.list", {});
        if (r.error) throw new Error(`agent ${who}: its projects cannot be checked (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`);
        const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
        const a = list.find(x => x && x.name === who);
        if (!a) throw refuse(`no agent ${who}`, "denied");
        const assistant = a.kind === "assistant";
        if (assistant && kind === "facts") return { all: true, agent: who };
        const all = P.list().projects.map(p => ({ slug: p.slug, name: p.name, folders: p.workspaces ? [p.home, ...p.workspaces] : [p.home], threads: p.picks || [] }));
        if (assistant) return { all: false, agent: who, projects: all };
        const wildcard = a.projects === "*";
        const mine = new Set(Array.isArray(a.projects) ? a.projects.map(String) : []);
        const candidate = wildcard ? all : all.filter(p => mine.has(p.slug) || mine.has(p.name));
        const checked = await Promise.all(candidate.map(async p => {
          const c = await ctx.call("projects.access.check", { project: p.slug, agent: who });
          if (c.error && c.error.code === "no_such_tool") return p; // no gate installed: agents.projects' own scope, unchanged
          return c.data && c.data.granted ? p : null;
        }));
        return { all: false, agent: who, projects: checked.filter(Boolean) };
      },
    });

    // Seeds a granted row for every agent's own agents.projects entry that has none yet, so an
    // agent already scoped to a project by agents.create/update keeps reading it once a caller
    // (memory's guard) starts checking projects.access too. Reviewer's MEDIUM 1: the earlier
    // version checked only the (project, agent) pair, so a wildcard revoke
    // (projects.access.revoke { project }, agent left out, meaning every agent) was undone the
    // next time this ran, because it inserted a fresh per-agent row anyway. Fixed the safer way
    // team-lead called for: skip a project ENTIRELY once it has any row at all, agent or status
    // irrelevant, so this only ever seeds a project nobody has touched through projects.access
    // yet. A projects: "*" agent (not the assistant, whose "*" is a different rule entirely) is
    // now seeded too, one row per project, the same as a named-projects agent, just for every
    // project instead of a named few (reviewer's follow-up on d897210d: without this, a wildcard
    // agent read nothing until someone granted it by hand, project by project).
    const seedFromAgents = async () => {
      const r = await ctx.call("agents.list", {});
      if (r.error) return { error: r.error };
      const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
      let seeded = 0;
      const projects = P.valid();
      const touched = new Set(/** @type {any[]} */ (db.prepare("SELECT DISTINCT project FROM projects_access").all()).map(x => x.project));
      for (const a of list) {
        if (!a || !a.name || a.kind === "assistant") continue;
        const targets = a.projects === "*" ? projects
          : Array.isArray(a.projects) ? projects.filter(p => a.projects.some((/** @type {any} */ ref) => p.slug === String(ref) || p.name.toLowerCase() === String(ref).toLowerCase()))
          : [];
        for (const p of targets) {
          if (touched.has(p.slug)) continue; // this project already has a grant or revoke on record; never override it
          db.prepare("INSERT INTO projects_access (id, project, agent, status, by, at) VALUES (?,?,?,?,?,?)")
            .run(crypto.randomUUID(), p.slug, normAgent(a.name), "granted", "projects.access.migrate", Date.now());
          seeded++;
        }
      }
      return { seeded };
    };

    ctx.tool("projects.access.migrate", {
      description: "Bootstrap for projects.access (Vyre Drive step 3, one source of truth): seeds a granted row for every agent's own agents.projects entry, including a projects: \"*\" agent's every project, for any project projects.access has never recorded a grant or revoke on. Never touches a project once it has any row at all, so a person's own revoke (even a wildcard one that covers every agent) is never undone. The assistant is untouched: its reach is the assistant rule, not a per-project grant. Runs automatically once, on the first start after this version, and is also here as a manual OWNER tool in case agents was not reachable yet at that first start (see projects.access.check's fallback to agents.projects alone when this module cannot be asked).",
      input: { type: "object", properties: {} },
      callers: OWNER,
      run: async () => {
        const r = await seedFromAgents();
        if (r.error) throw refuse(`agents cannot be listed (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`, "no_link");
        return { seeded: r.seeded };
      },
    });

    // Auto-seed once (reviewer's MEDIUM 2, team-lead's call): a person must never have to run
    // projects.access.migrate by hand for an upgrade not to look like every scoped agent lost
    // its memory access. Retried a few times, spaced out, in case agents starts after projects
    // in this boot (module.json declares no hard "requires" on agents: projects works fine
    // without it, so this can't be a real dependency edge, just a startup-order one). Marked
    // done in projects_access_seeded (its own migration step) ONLY once it has actually read a
    // real list from agents.list (reviewer's seed-order LOW, still open on 2fb4258c): a
    // no_such_tool answer used to be treated as final ("agents genuinely is not installed"),
    // but that is only true when agents really is disabled, which this cannot tell apart from
    // "agents hasn't started yet" by the error code alone. Retried the same as any other error
    // now; six tries, 500ms apart, is not enough to rule out a permanent problem, only a
    // boot-order race, so a real, lasting outage (or a genuinely agents-less install) leaves
    // this unmarked and retries again next boot, cheap either way. Going forward this matters
    // less: agents.create/update and projects.create write the grant as it happens (option (a)
    // below), so this seed only ever backfills what existed before this version.
    // The returned promise is here for tests to await determinism on, never used by real
    // callers: nothing in production needs to wait on the auto-seed before start() returns.
    // A test that awaits this promise (access.test.js's own started()) would otherwise pay the
    // full 6-try, 2.5s retry cost on every no_such_tool too, now that no_such_tool is retried
    // like any other error: sped up under node --test, same convention core/config/dialogs.js
    // and core/recall/index.js use, never in production.
    const RETRY_MS = process.env.NODE_TEST_CONTEXT ? 5 : 500;
    const autoSeed = db.prepare("SELECT 1 FROM projects_access_seeded").get() ? Promise.resolve() : (async () => {
      for (let i = 0; i < 6; i++) {
        const r = await seedFromAgents();
        if (!r.error) { db.prepare("INSERT OR IGNORE INTO projects_access_seeded (id, at) VALUES (1, ?)").run(Date.now()); return; }
        await new Promise(res => setTimeout(res, RETRY_MS));
      }
      ctx.log("projects.access: could not auto-seed from agents.projects after 6 tries; run projects.access.migrate by hand once agents is up");
    })();

    return { async stop() {}, seeded: autoSeed };
  },
};
