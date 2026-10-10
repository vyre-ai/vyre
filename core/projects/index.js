// @ts-check
// The projects module: the tools over ./projects.js. Recall and Memory are used through
// ctx.call and are not listed under requires, because projects must still start, list and
// brief without them; it only searches less and says so.

import fs from "node:fs";
import path from "node:path";
import { Projects, MIGRATIONS, threadId } from "./projects.js";
import { label } from "./brief.js";
import { wantsMacs, askMacs, mergeRows, sourcesOf, boxLabel, macLabel } from "../modules/federate.js";
import { isProjectId } from "../../lib/project-id.js";
import { ownerDevice } from "../modules/index.js";
import { real } from "./folders.js";
import { within } from "../../lib/within.js";
import { backupSources } from "./backup.js";
import { grantReach, revokeReach, reachGrants, mayReach, asPerson } from "../../lib/project-reach.js";

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
/** The person's own surfaces and modules acting for them: never a model (an agent or a session is mcp). */
const PERSON_ONLY = [...OWNER, "module"];
/** projects.catalog lists every session on the device with its first message: the person's surfaces (the Deck and Capsule over a device or the tailnet too) and modules, never a model. */
const CATALOG_READERS = [...OWNER, "mobile", "tailnet", "device", "module"];
// Reviewer's MEDIUM 2 on f8330ccc: callers: ["module"] alone lets ANY module reach these three,
// third-party ones installed into the modules folder included — modules skip presence entirely,
// so an installed module could grant an agent any project, or clear a person's explicit revokes
// (clear deletes them outright; a wildcard grant then re-applies as if they never happened).
// Only agents (option (a)'s own sync) and this module itself (projects.create's own wildcard
// grant) may reach them this way; everyone else keeps the owner-plus-presence door above.
// Reviewer's MEDIUM on 7021d4e1: projects.create had no callers at all (open to an agent's own
// MCP, a guest, a hook — anything), so an agent could map any folder into a brand-new project
// and, through f8330ccc's own auto-grant, walk straight in with projects.access on it (a
// never-unmapped folder became a mapped one at the agent's own request). The loader-level
// callers list below closes that (OWNER, plus module callers only); this narrows further, to the
// modules that have real business proposing a folder-to-project mapping on their own: sync's
// attachMapped (core/sync/index.js), which calls exactly these two tools the first time a synced
// folder's confirmed mapping actually lands a file (create when the confirmed slug is new,
// add-workspace when the project already exists); and github's github.project (core/github,
// ADR 0041), which clones a repo and then creates or attaches to a project the same way, rather
// than writing projects_projects directly.
const MAPPING_ALLOWED = new Set(["module:sync", "module:github"]);
const mappingOK = meta => MAPPING_ALLOWED.has(String((meta && meta.caller) || ""));
const moduleCallerRefusal = (meta, tool) => {
  const caller = String((meta && meta.caller) || "");
  if (caller.startsWith("module:") && !mappingOK(meta)) {
    throw refuse(`${tool} is the person's own door plus sync's and github's proposed mappings, not ${caller}'s`, "denied");
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
    const setHistory = (project, state) => ctx.store.db.prepare("INSERT INTO projects_history (project, state, at) VALUES (?,?,?) ON CONFLICT(project) DO UPDATE SET state = excluded.state, at = excluded.at").run(project, state, Date.now());
    try { P.refresh(); } catch (e) { ctx.log("could not read the projects: " + /** @type {Error} */ (e).message); }

    ctx.tool("projects.list", {
      description: "Every project with name, home, folders, people, avatar_seed, thread count and picked thread ids (picks), newest activity first.",
      input: { type: "object", properties: { machines, archived: { type: "boolean" } } },
      run: async (input, meta = {}) => { const caller = meta.caller;
        if (!(await wantsMacs(ctx, input, caller, meta))) return P.list({ archived: Boolean(input.archived) });
        // On the box, for the person: the box's projects, then each Mac's, every one labelled.
        const [own, answers] = await Promise.all([P.list({ archived: Boolean(input.archived) }), askMacs(ctx, "projects.list", { archived: Boolean(input.archived) })]);
        return { ...own, projects: mergeRows(ctx, own.projects, answers, { rows: d => d && d.projects }),
          problems: mergeRows(ctx, own.problems, answers, { rows: d => d && d.problems }), sources: sourcesOf(ctx, answers) };
      },
    });
    ctx.tool("projects.create", {
      description: "Make a project by hand: a name, a home folder (default: a new folder in the projects folder), other folders it owns, the threads picked into it, and its people. from_thread: the chat this project is made from; it is picked in and its id becomes the project's avatar_seed, so the chat's tile carries over (otherwise the seed is the new slug). Every projects: \"*\" agent (never the assistant, whose \"*\" is a different rule) is granted projects.access on it at once too, option (a) (the lead's decision, so agents.projects and projects.access never drift apart): a wildcard agent reads a brand-new project the moment it exists, with no separate step. callers is the person's own surfaces plus sync's and github's own doors (module:sync, module:github), for their own proposed folder-to-project mappings; every other module is refused.",
      input: { type: "object", required: ["name"], properties: { name: str, home: str, org: str, workspaces: strs, threads: strs, people: { type: "array", items: person }, watchers: strs, from_thread: str } },
      callers: [...OWNER, "module"],
      run: async (input, meta = {}) => {
        moduleCallerRefusal(meta, "projects.create");
        // from_thread must name a chat that exists (reviewer LOW): in the Recall index, or a live
        // switchboard thread not indexed yet. A made-up string would become a pick and the seed.
        if (input.from_thread != null) {
          // One form for every check below and for the marker: an upper-case UUID is the same chat.
          const id = threadId(input.from_thread);
          if (!id) throw Object.assign(new Error("from_thread must be a chat's session id (a UUID)"), { code: "bad_input" });
          input = { ...input, from_thread: id };
          if (!P.hasSession(id)) {
            const t = await ctx.call("threads.get", { thread: id, limit: 1 });
            if (t.error || !t.data?.thread) throw Object.assign(new Error(`there is no chat ${id} to make a project from`), { code: "not_found" });
          }
        }
        const before = P.previewHome(input);
        const created = P.create(input);
        // An agent whose `projects` is "*" holds ONE kernel grant on every project (made when it was given that scope), so a new project is reached without a grant per project.
        // Version history with no GitHub needed (charter): a new folder gets it quietly; an
        // existing folder that is not a repo gets one quiet offer, once. A module caller (sync,
        // github) maps folders it made itself and is never asked or offered anything.
        if (String((meta && meta.caller) || "").startsWith("module:") || before.isRepo) return created;
        if (before.fresh) {
          const g = await ctx.call("github.project.local-init", { project: created.slug }).catch(e => ({ error: { message: String(e && e.message || e) } }));
          if (!g.error) setHistory(created.slug, "kept");
          else ctx.log?.(`projects: no local history for ${created.slug}: ${g.error.message}`);
          return created;
        }
        setHistory(created.slug, "offered");
        return { ...created, offer: { kind: "history", question: "Keep version history for this folder?", tool: "projects.history", input: { project: created.slug } } };
      },
    });
    ctx.tool("projects.history", {
      description: "Answer whether a project's folder keeps version history: true makes it a local git repo, with a copy, branch and Undo per session; false declines.",
      input: { type: "object", required: ["project", "keep"], properties: { project: str, keep: { type: "boolean", description: "true makes the folder a local git repo (no remote); false is never asked again; a folder with history is left as it is" } } },
      callers: [...OWNER, "mcp"],
      run: async ({ project, keep }, meta = {}) => {
        const p = P.resolve(project);
        await ownOrSession(meta, p.slug);
        if (!keep) { setHistory(p.slug, "declined"); return { project: p.slug, state: "declined" }; }
        const g = await ctx.call("github.project.local-init", { project: p.slug }).catch(e => ({ error: { code: "unavailable", message: String(e && e.message || e) } }));
        if (g.error) throw Object.assign(new Error(g.error.message), { code: g.error.code });
        setHistory(p.slug, "kept");
        return { project: p.slug, state: "kept", ...g.data };
      },
    });
    // Rename and archive are the person's, and their agent's on their behalf: a session in that project.
    const ownOrSession = async (meta, slug) => {
      // The person's assistant acts for them across every project (vyred's verified identity, meta.agentKind).
      // TODO(P17): also require the person's own words asked for it (vault.said.match) once the Gate lands.
      if (meta.agentKind === "assistant") return;
      if (OWNER.includes(String(meta.caller || "").split(":")[0]) && !isAgent(meta.caller)) return;
      const t = meta.thread && await ctx.call("threads.get", { thread: meta.thread }).catch(() => null);
      if (isAgent(meta.caller) || !(t && t.data && t.data.thread && t.data.thread.project === slug))
        throw refuse("this is the person's, or a session in that project acting on their request", "denied");
    };
    ctx.tool("projects.rename", {
      description: "Rename a project. The slug, folder, threads, teammates and tile stay exactly as they were; only the name changes. Person-only: a model (agent or session) is refused.",
      input: { type: "object", required: ["project", "name"], properties: { project: str, name: str } },
      callers: PERSON_ONLY,
      run: async ({ project, name }) => P.rename(P.resolve(project).slug, name),
    });
    ctx.tool("projects.archive", {
      description: "Archive a project: it leaves the project list, and its folder, threads, teammates and history are untouched. archived: false brings it back. projects.list {archived: true} includes archived projects. Person-only: a model (agent or session) is refused.",
      input: { type: "object", required: ["project"], properties: { project: str, archived: { type: "boolean" } } },
      callers: PERSON_ONLY,
      run: async ({ project, archived = true }) => P.archive(P.resolve(project).slug, archived),
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
      description: "Attach an existing folder to an existing project as one of its workspaces (Vyre Drive step 4): the folder starts counting as the project's own, the same as one listed at projects.create time. For confirming sync.consent's proposed folder-to-project mapping, or attaching any other folder by hand. Person-only, instant, no presence: a placement decision, same weight as a pick. Refuses a project that does not exist; a folder that resolves to the project's own home is a no-op (added: null), not an error. callers is the person's own surfaces plus sync's and github's own doors (module:sync, module:github), the same named exception as projects.create; every other module is refused.",
      input: { type: "object", required: ["project", "folder"], properties: { project: str, folder: str } },
      callers: [...OWNER, "module"],
      run: async ({ project, folder }, meta = {}) => {
        moduleCallerRefusal(meta, "projects.add-workspace");
        return P.addWorkspace(project, folder);
      },
    });
    ctx.tool("projects.catalog", {
      callers: CATALOG_READERS,
      description: "Every session on this device for picking into projects, with its /rename name, first message, folder, last activity, projects, and live (a terminal has it open now). q searches names, first messages, folders and, through Recall, what was said.",
      input: { type: "object", properties: { q: str, limit: { type: "integer" }, human: { type: "boolean" }, machines } },
      run: async (input, meta = {}) => { const caller = meta.caller;
        const { machines: _, ...own } = input;
        if (!(await wantsMacs(ctx, input, caller, meta))) return withLive(ctx, await P.catalog(own));
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
      // folder: the real path the answer was judged on (symlinks and `..` resolved), which the registry puts back in an agent's call so the tool runs on what was checked.
      run: async ({ cwd }) => { const p = P.of(cwd); return p ? { slug: p.slug, name: p.name, home: p.home, folders: p.workspaces, folder: real(cwd) } : null; },
    });
    ctx.tool("projects.threads", {
      description: "The threads in a project, newest first, each saying whether it was picked or ran in the project's folders.",
      input: { type: "object", required: ["project"], properties: { project: str, limit: { type: "integer" }, machines } },
      run: async (input, meta = {}) => { const caller = meta.caller;
        const { project, limit = 100 } = input;
        P.refresh();
        const rows = P.threadsOf(P.resolve(project));
        if (!(await wantsMacs(ctx, input, caller, meta))) return rows.slice(0, limit);
        // On the box, for the person: a pick the box has no session for may be a Mac session
        // picked from the Deck. The Macs are asked once, for those ids only, and what they have
        // comes back labelled and is never stored here. A pick no machine has stays missing.
        const ids = rows.filter(t => t.missing).map(t => t.id);
        const answers = ids.length ? await askMacs(ctx, "recall.sessions", { ids, limit: ids.length }) : [];
        return resolvePicks(ctx, rows, answers).slice(0, limit);
      },
    });
    ctx.tool("projects.context", {
      description: "The plain-text brief for a thread starting in a project: its purpose, people, other threads and memory. Give project, or cwd and session.",
      input: { type: "object", properties: { project: str, cwd: { type: "string", description: "as a SessionStart hook sees it" }, session: { type: "string", description: "as a SessionStart hook sees it" } } },
      run: async input => P.context(input),
    });
    // The work module tells this computer about a Project record it made (and about one made on another computer): a local row and a home folder, nothing else. Only the work module may.
    ctx.tool("projects.adopt", {
      description: "This computer learns of a Project record: a local row and a home folder for it. Only the work module calls it.",
      input: { type: "object", required: ["slug", "name"], properties: { slug: str, name: str } },
      callers: ["module"],
      run: async ({ slug, name }, meta = {}) => {
        if (String((meta && meta.caller) || "") !== "module:work") throw refuse("only the work module adopts a project this way; work.project.create makes one", "denied");
        const p = P.adopt({ slug, name });
        return { slug: p.slug, name: p.name, home: p.home };
      },
    });

    // projects.access: which agents may reach a project. There is no table here: it is a KERNEL GRANT (action project.reach on the Project record, subject the agent), the one permission system
    // (lib/project-reach.js). Giving and taking it away are a person's acts with the kernel's own proof; deny by default is the kernel's. An agent whose `projects` is "*" holds ONE grant on
    // every project (`vyre://<space>/project/*`), so a project made later is reached too.
    const K = ctx.kernel;
    const normAgent = (/** @type {any} */ agent) => String(agent || "").toLowerCase();
    // The kernel's grants name an agent by its stable id, never its name (a name given to a new agent after a delete inherits nothing): the agents module answers one for the other.
    const uidOf = async (/** @type {string} */ name) => { const r = await ctx.call("agents.uid", { name }); return r && r.data ? String(r.data.uid) : null; };
    /** @type {() => Promise<Map<string, string>>} uid to name for every agent now */
    const namesByUid = async () => new Map((await agentsList()).map((/** @type {any} */ a) => [String(a.uid), String(a.name)]));
    const WILD = () => `vyre://${K.space}/project/*`;
    /** The Project record's address for a short name, made if the Space has none yet. */
    const urnOfSlug = async (/** @type {string} */ slug) => {
      const rec = await ctx.call("work.project.ensure", { slug, name: P.resolve(slug).name });
      if (rec.error) throw refuse(`project ${slug} has no record to grant on: ${rec.error.message}`, rec.error.code === "not_found" ? "not_found" : "unavailable");
      return String(rec.data.urn);
    };
    const agentsList = async () => {
      const r = await ctx.call("agents.list", {});
      if (r.error) throw refuse(`agents cannot be listed (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message}); check that agents are running, then call again`, "no_link");
      return (Array.isArray(r.data) ? r.data : r.data?.agents || []).filter((/** @type {any} */ a) => a && a.name && a.kind !== "assistant");
    };
    if (!K || typeof K.agentMay !== "function") ctx.log("projects.access: this build has no kernel grants to ask; agents reach no project");
    const needKernel = () => { if (!K || !K.grants) throw refuse("project reach is a kernel grant, and there is no kernel here; run this on the machine that hosts the Space", "unavailable"); };

    // The Project record's address for a short name: what a kernel grant names. For the agents module, which makes grants in the person's own create or update.
    ctx.tool("projects.backup.sources", {
      description: "What the Basic encrypted backup reads of this computer's projects: { items: [{ kind: \"file\", name, size, mtime, path } and the project rows as rows/projects.jsonl], notices }. Ignore rules applied (build output, dependency folders, caches, logs), files over 2 GB skipped with a notice. The memory module's own.",
      input: { type: "object", properties: {} },
      callers: ["module"],
      run: async (_i, meta = {}) => {
        if (String((meta && meta.caller) || "") !== "module:memory") throw refuse("only the memory module asks for backup sources; memory.backup.status shows the backup", "denied");
        return backupSources(P.valid());
      },
    });
    ctx.tool("projects.record", {
      description: "The Project record for a short name: { urn }. Only the agents module asks.",
      input: { type: "object", required: ["project"], properties: { project: str } },
      callers: ["module"],
      run: async ({ project }, meta = {}) => {
        if (String((meta && meta.caller) || "") !== "module:agents") throw refuse("only the agents module asks for a project's record address; projects.list shows the projects", "denied");
        return { urn: await urnOfSlug(P.resolve(project).slug) };
      },
    });
    ctx.tool("projects.access.grant", {
      description: "Let an agent reach a project's data (Drive, synced sessions, anything project-scoped asks projects.access.check before serving an agent): a kernel grant of project.reach on the project's record, a person's own act with the kernel's proof. agent left out or empty grants every agent that exists now.",
      input: { type: "object", required: ["project"], properties: { project: str, agent: str } },
      callers: OWNER,
      run: async ({ project, agent }, meta = {}) => {
        needKernel();
        const slug = P.resolve(project).slug, urn = await urnOfSlug(slug);
        const names = normAgent(agent) ? [normAgent(agent)] : (await agentsList()).map((/** @type {any} */ a) => normAgent(a.name));
        for (const n of names) { const uid = await uidOf(n); if (!uid) throw refuse(`no agent ${n} (agents.list shows them)`, "not_found"); await grantReach(K, meta, { urn, agent: uid }); }
        return { project: slug, agent: normAgent(agent), status: "granted", agents: names };
      },
    });
    ctx.tool("projects.access.revoke", {
      description: "Take an agent's (or, agent left out, every agent's) access to a project away: its kernel grant is revoked, which also takes away anything delegated from it. An agent that held ONE grant on every project keeps every OTHER project as explicit grants. Instant for the person.",
      input: { type: "object", required: ["project"], properties: { project: str, agent: str } },
      callers: OWNER,
      run: async ({ project, agent }, meta = {}) => {
        needKernel();
        const slug = P.resolve(project).slug, urn = await urnOfSlug(slug);
        const { chain } = await asPerson(K, meta);
        const uids = normAgent(agent) ? [await uidOf(normAgent(agent))].filter(Boolean) : [...new Set((await reachGrants(K, chain, {})).map((/** @type {any} */ g) => String(g.subject.actor.id)))];
        let revoked = 0;
        for (const n of /** @type {string[]} */ (uids)) {
          // an agent with the every-project grant keeps all the others one by one: an allow-only grant cannot say "everything but this"
          if ((await reachGrants(K, chain, { urn: WILD(), agent: n })).length) {
            await revokeReach(K, meta, { urn: WILD(), agent: n });
            for (const p of P.valid()) if (p.slug !== slug) await grantReach(K, meta, { urn: await urnOfSlug(p.slug), agent: n });
            revoked++;
          }
          revoked += await revokeReach(K, meta, { urn, agent: n });
        }
        return { project: slug, agent: normAgent(agent), status: "revoked", revoked };
      },
    });
    ctx.tool("projects.access.check", {
      description: "Whether a named agent may reach a project's data: deny by default, asked of the kernel (a grant on the project's record or on every project). Returns { granted }.",
      input: { type: "object", required: ["project", "agent"], properties: { project: str, agent: str } },
      callers: ["module", "cli", "local", "deck", "capsule"],
      run: async ({ project, agent }) => {
        const a = normAgent(agent);
        if (!a) return { project, agent: "", granted: false };
        if (!isProjectId(project)) return { project, agent: a, granted: false };
        if (!K || typeof K.agentMay !== "function") return { project, agent: a, granted: false };
        let urn;
        try { urn = await urnOfSlug(project); } catch { return { project, agent: a, granted: false }; }
        const uid = await uidOf(a);
        return { project, agent: a, granted: uid ? await mayReach(K, uid, urn) : false };
      },
    });
    // What agents could reach before reach became a kernel grant: the old rows wait in projects_access_legacy until the person approves carrying them over. A grant needs the person's own proof, so
    // neither the migration nor a start can make one. `granted` rows become grants (an agent by its stable id); an explicit revoke is never re-granted; a row with no agent was the project's default
    // for any agent with no row of its own. Afterwards the holding table is emptied.
    const legacyRows = () => { try { return /** @type {any[]} */ (ctx.store.db.prepare("SELECT project, agent, status FROM projects_access_legacy").all()); } catch { return []; } };
    ctx.tool("projects.access.pending", {
      description: "What agents could reach before reach became a kernel grant, still waiting for your approval to carry over: { rows, grants }. Read only.",
      input: { type: "object", properties: {} },
      callers: [...OWNER, "module"],
      run: async () => {
        const rows = legacyRows();
        /** @type {Record<string, number>} */ const byProject = {};
        for (const r of rows) if (r.status === "granted") byProject[String(r.project)] = (byProject[String(r.project)] || 0) + 1;
        return { pending: rows.length, granted: Object.values(byProject).reduce((n, c) => n + c, 0), by_project: byProject, rows: rows.map(r => ({ project: r.project, agent: r.agent || "(every agent)", status: r.status })) };
      },
    });
    ctx.tool("projects.access.restore", {
      description: "Carry what your agents could reach before into kernel grants, in your own call: every granted row becomes a project.reach grant (an agent by its stable id), an explicit revoke stays revoked, and the old rows are then cleared. { restored, skipped }.",
      input: { type: "object", properties: {} },
      callers: OWNER,
      run: async (_i, meta = {}) => {
        needKernel();
        const rows = legacyRows();
        const live = (await agentsList()).filter((/** @type {any} */ a) => a.kind !== "assistant");
        const own = new Set(rows.filter(r => r.agent).map(r => `${r.project}\u0000${String(r.agent).toLowerCase()}`));
        let restored = 0, skipped = 0;
        /** @param {string} project @param {string} name */
        const grant = async (project, name) => {
          const uid = await uidOf(name.toLowerCase());
          if (!uid) { skipped++; return; }
          let urn; try { urn = await urnOfSlug(project); } catch { skipped++; return; }
          await grantReach(K, meta, { urn, agent: uid }); restored++;
        };
        for (const r of rows) {
          if (r.status !== "granted") { skipped++; continue; }
          if (r.agent) await grant(String(r.project), String(r.agent));
          else for (const a of live) { if (!own.has(`${r.project}\u0000${String(a.name).toLowerCase()}`)) await grant(String(r.project), String(a.name)); }
        }
        try { ctx.store.db.exec("DELETE FROM projects_access_legacy"); } catch { /* no table: nothing to clear */ }
        return { restored, skipped };
      },
    });
    ctx.tool("projects.access.list", {
      description: "Every project reach grant on record, for a project or every project, for the owner to review who can reach what.",
      input: { type: "object", properties: { project: str } },
      callers: OWNER,
      run: async ({ project }, meta = {}) => {
        needKernel();
        const { chain } = await asPerson(K, meta);
        const urn = project ? await urnOfSlug(P.resolve(project).slug) : undefined;
        const grants = await reachGrants(K, chain, urn ? { urn } : {});
        const names = await namesByUid();
        return { grants: grants.map((/** @type {any} */ g) => ({ project: g.resource.prefix === WILD() ? "*" : g.resource.prefix, agent: names.get(String(g.subject.actor.id)) || g.subject.actor.id, status: g.status, by: g.issuer && g.issuer.id, at: g.created_at })) };
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
    // The session and the agent are what the daemon vouched (meta.thread and meta.agent, forwarded by the asking module as `thread` and `claim`), never the `:thread:<id>` or `:agent:<name>` text of a label (RC-1).
    // SHIM (kernel off, or an asking module that does not forward meta yet): when neither `thread` nor `claim` is given, the label's own text is read as before.
    const reachOwnSession = (c, thread, claim) => (thread !== undefined || claim !== undefined)
      ? !claim && /^mcp(?:$|[\s:])/.test(String(c || "")) && (c === "mcp" || Boolean(thread))
      : /^mcp(?::thread:[A-Za-z0-9_-]+)?$/.test(String(c || ""));
    const reachAgentOf = (c, claim) => claim !== undefined ? (claim ? String(claim) : null) : /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/.exec(String(c || ""))?.[1] || null;
    ctx.tool("projects.reach", {
      description: "Which projects (and their folders) a caller may reach: the one door core/memory, core/recall and core/files all ask instead of keeping their own copy of this check. caller is the ORIGINAL caller the asking module itself received (ctx.call always relabels the actual meta.caller \"module:<name>\", so the owner-vs-refused decision below has to be told this explicitly rather than reading it off the call the registry sees); trusted because only a first-party module can reach this tool at all, and that module is the one responsible for forwarding it faithfully. { all: true } for the true owner (its own surfaces, a module, its own session, or an owner device): no restriction. Otherwise { all: false, agent, projects: [{slug, name, folders, threads}] }, deny by default. kind \"facts\" additionally gives the assistant { all: true } too (personal facts, distilled, not raw content); kind \"content\" (the default) never does, even for the assistant, which instead gets every project that exists, unconditional and never checked against projects.access (a different privilege tier from a projects: \"*\" agent, which is checked). A model never asks this on its own behalf: it cannot, callers being module-only.",
      input: { type: "object", properties: { agent: str, caller: str, thread: str, claim: { type: ["string", "null"] }, kind: { type: "string", enum: ["facts", "content"] }, person: { type: "boolean" } } },
      callers: ["module"],
      run: async ({ agent, caller, kind = "content", person, thread, claim }) => {
        const said = reachAgentOf(caller, claim);
        if (said && agent && said !== agent) throw refuse(`the call came from agent ${said} but names agent ${agent}; name the agent you are, or leave agent out`, "denied");
        const who = said || agent || null;
        if (!who) {
          // The asking module passes `person` from the kernel's chain for the call (exactly one person hop): then that fact, never the label, decides the owner. Without it (no kernel) the labels do, as before.
          if (typeof person === "boolean") { if (person || String(caller || "").startsWith("module:")) return { all: true, agent: null }; throw refuse(`refused for ${String(caller || "an unnamed caller").slice(0, 60)}; ask the person to do this`, "denied"); }
          if (reachOwner(caller) || reachOwnSession(caller, thread, claim) || ownerDevice(caller)) return { all: true, agent: null };
          throw refuse(`refused for ${String(caller || "an unnamed caller").slice(0, 60)}; ask the person to do this`, "denied");
        }
        const r = await ctx.call("agents.list", {});
        if (r.error) throw new Error(`agent ${who}: its projects cannot be checked (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`);
        const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
        const a = list.find(x => x && x.name === who);
        if (!a) throw refuse(`no agent ${who} (agents.list shows them)`, "denied");
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

    return { async stop() {} };
  },
};
