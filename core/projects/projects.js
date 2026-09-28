// @ts-check
// projects — a project is a home folder, the other folders it owns, the threads in it, its
// people and its watchers (docs/SPEC.md, section 7.2).
//
// Projects are made by hand. At onboarding a person picks sessions from the catalogue, which is
// every session on the device, searchable by what was said in it. An earlier design sorted
// sessions into projects automatically by what they talked about; it filed hub sessions under
// whichever client they named most and was dropped. What remains are two ways a thread belongs:
//
//   picked   a person put it there. Recorded in the marker, so it survives anything. A session
//            can be picked into as many projects as it is work for: a weekly planning session
//            that covers two clients belongs to both. Only a person removes a pick.
//   folder   it ran in one of the project's folders. A fact about where the work happened,
//            worked out fresh on every read, so a folder added to a marker brings its sessions
//            with it and nothing has to be rebuilt.
//
// Sessions come from Recall's tables (core/recall/schema.js), read directly: reads may join any
// table. Search by content and memory facts go through ctx.call, so this module keeps working,
// with less, when Recall or Memory is not running.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as M from "./markers.js";
import { untilde } from "../config/index.js";
import { compose, label } from "./brief.js";

// Reviewer's LOW on 7021d4e1: a project's home or workspace must never be the whole disk, the
// whole home account, or one of the credential/vault folders under it — granting an agent
// projects.access on a project scoped that wide hands it the person's real keys and vault the
// moment the grant lands (create()'s own wildcard-agent grant, and any add-workspace after).
// Names mirror core/files/safety.js's HOME_DENIED so the two lists never disagree about what is
// sensitive; kept as its own short list here rather than imported, since core/projects may not
// import core/files (test/boundaries.test.js — no such edge is allowlisted, and this is three
// names, not worth a new one). Reviewer's MEDIUM 3 (second pass): "Library" added (Keychains,
// Mail, Cookies and more all live under it, not just Keychains), and the check below now also
// refuses an ANCESTOR of any of these, not only the folder itself or something inside it: "/Users"
// (or whatever holds the real home) contains the home directory, and so every credential folder
// under it, as a subfolder the moment IT becomes a project's own folder; "~/.config" is the parent
// of gcloud's own creds the same way.
const SENSITIVE = [".vyre", ".claude", ".ssh", ".gnupg", ".aws", path.join(".config", "gcloud"), ".docker", ".kube", ".netrc", "Library"];
/** Throws when p, resolved, is "/", the real home directory, one of SENSITIVE below it, or an
 * ancestor of any of those three (which contains it as a subfolder once granted). */
function refuseSensitiveRoot(p) {
  const abs = M.real(String(p));
  const home = M.real(os.homedir());
  const root = path.parse(abs).root;
  // Reviewer's HIGH on 13e7b0e8: root and home themselves are refused only as an exact match or
  // an ANCESTOR of them (which would enclose them, and so every credential folder they hold, as
  // one of the project's own subfolders) - never merely for sitting INSIDE them, which is where
  // almost every real project actually lives (~/Work, ~/Projects, ...). The earlier version's
  // single "inside-or-ancestor" check applied to home too, refusing every real project under it.
  for (const b of [root, home]) {
    if (abs === b || b.startsWith(abs + path.sep)) throw new Error(`${p} cannot be a project's folder`);
  }
  // Each named SENSITIVE folder, unlike root/home above, IS refused for sitting inside it too
  // (a project must never be nested inside ~/.ssh, say), on top of being it or an ancestor of it.
  for (const d of SENSITIVE) {
    const full = path.join(home, d);
    if (abs === full || abs.startsWith(full + path.sep) || full.startsWith(abs + path.sep)) {
      throw new Error(`${p} cannot be a project's folder`);
    }
  }
}

export const MIGRATIONS = [
  `
  -- A cache of the markers: where each project's home is, so a project outside the configured
  -- roots is still found, and its last-read contents. The marker wins whenever they disagree.
  CREATE TABLE projects_projects (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    home TEXT NOT NULL UNIQUE,
    spec TEXT NOT NULL,
    at   INTEGER NOT NULL
  );
  `,
  // Step 1 (federation, Vyre Drive step 3): which agent may reach a project's data at all. Deny
  // by default; Drive, sync and anything else that serves a project's files or sessions to an
  // agent asks projects.access.check before serving. Lives here, not appended in index.js, so
  // core/store's migrate() (which numbers steps by array index) never collides with a step
  // another team adds to this array later — sessions' next MIGRATIONS step (after e87f63df,
  // still just the projects_projects table on main as of this write) is told this slot is taken.
  `
  CREATE TABLE projects_access (
    id      TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    agent   TEXT NOT NULL DEFAULT '',
    status  TEXT NOT NULL,
    by      TEXT NOT NULL,
    at      INTEGER NOT NULL,
    UNIQUE (project, agent)
  );
  `,
  // Step 2 (federation, reviewer's MEDIUM 2 on 656b3f79): a single-row sentinel recording that
  // the one-time auto-seed of projects_access from agents.projects has run (core/projects/
  // index.js), so an upgrade never has to be told about the manual projects.access.migrate tool
  // for a scoped agent to keep reading what it already could.
  `
  CREATE TABLE projects_access_seeded (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at INTEGER NOT NULL
  );
  `,
];

/** @typedef {import("./markers.js").Project} Project */
/** @typedef {(tool: string, input: any) => Promise<{ data?: any, error?: { code: string, message: string } }>} Call */

export class Projects {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, config: any, call?: Call,
   *           emit?: (type: string, payload: object, where?: { project?: string, thread?: string }) => void }} deps
   */
  constructor({ db, config, call, emit }) {
    this.db = db;
    this.config = config;
    this.call = call || (async () => ({ error: { code: "no_such_tool", message: "no tools here" } }));
    this.emit = emit || (() => {});
    /** @type {Project[]} */
    this.all = [];
  }

  /** Where markers are looked for: the projects folder Vyre creates homes in, and the user's roots. */
  roots() {
    return [...new Set([this.config.projectsDir, ...(this.config.roots || [])].filter(Boolean))];
  }

  /**
   * Re-read every known marker, and with walk, look under the roots for new ones. Reading known
   * markers is a handful of small files, cheap enough for every call; the walk is not, so only
   * listing and creating do it.
   */
  refresh({ walk = false } = {}) {
    const known = this.db.prepare("SELECT slug, home FROM projects_projects ORDER BY at").all();
    const byHome = new Map();
    for (const r of known) { const p = M.load(String(r.home)); if (p) byHome.set(p.home, p); }
    if (walk) for (const p of M.discover(this.roots())) if (!byHome.has(p.home)) byHome.set(p.home, p);
    const list = M.flagClashes([...byHome.values()]);
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      // A marker that is gone takes its project with it: the file is the declaration.
      const homes = new Set(list.filter(p => !p.error).map(p => p.home));
      for (const r of known) if (!homes.has(String(r.home))) this.db.prepare("DELETE FROM projects_projects WHERE home = ?").run(r.home);
      const up = this.db.prepare(`INSERT INTO projects_projects (slug, name, home, spec, at) VALUES (?,?,?,?,?)
        ON CONFLICT(slug) DO UPDATE SET name = excluded.name, home = excluded.home, spec = excluded.spec`);
      for (const p of list) if (!p.error) {
        this.db.prepare("DELETE FROM projects_projects WHERE home = ? AND slug != ?").run(p.home, p.slug);
        up.run(p.slug, p.name, p.home, JSON.stringify(p), now);
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.all = list;
    return list.filter(p => !p.error);
  }

  valid() { return this.all.filter(p => !p.error); }

  /** A project by slug, name or home folder. */
  resolve(ref) {
    const r = String(ref || "").trim();
    if (!r) throw new Error("which project? give its name or slug");
    const list = this.valid();
    const abs = M.real(untilde(r));
    const p = list.find(x => x.slug === r) || list.find(x => x.name.toLowerCase() === r.toLowerCase())
      || list.find(x => x.slug === M.slugify(r)) || list.find(x => x.home === abs);
    if (!p) throw new Error(`no project ${r}`);
    return p;
  }

  // ------------------------------------------------------------ changing projects

  /**
   * Make a project from what a person chose. The home defaults to a new folder in the projects
   * folder. A folder that already has a marker is refused, not overwritten.
   */
  create({ name, home, org, workspaces = [], threads = [], people = [], watchers = [] }) {
    const clean = String(name || "").trim();
    if (!clean) throw new Error("a project needs a name");
    const slug = M.slugify(clean);
    if (!slug) throw new Error(`"${clean}" has no letters or digits to make a slug from`);
    this.refresh({ walk: true });
    const where = M.real(home ? untilde(home) : path.join(this.config.projectsDir, slug));
    refuseSensitiveRoot(where);
    for (const w of workspaces) refuseSensitiveRoot(w);
    const clash = this.valid().find(p => p.slug === slug);
    if (clash) throw new Error(`a project called ${clash.name} already exists at ${clash.home}`);
    if (fs.existsSync(path.join(where, M.MARKER))) throw new Error(`${where} is already a project home`);
    fs.mkdirSync(where, { recursive: true });
    const ids = [...new Set(threads.map(M.parentOf))];
    const p = /** @type {Project} */ (M.write(where, {
      name: clean, ...(org ? { org: String(org) } : {}),
      workspaces: M.relative(where, workspaces).filter(w => w !== "."),
      threads: ids, people, watchers,
    }));
    this.db.prepare("INSERT OR REPLACE INTO projects_projects (slug, name, home, spec, at) VALUES (?,?,?,?,?)")
      .run(p.slug, p.name, p.home, JSON.stringify(p), Date.now());
    this.refresh();
    this.emit("project.created", { project: p.slug, name: p.name, home: p.home, threads: ids.length }, { project: p.slug });
    for (const id of ids) this.emit("thread.picked", { project: p.slug, thread: id }, { project: p.slug, thread: id });
    return p;
  }

  /** Pick threads into a project. Already-picked threads are left alone, and emit nothing. */
  addThreads(ref, ids) {
    this.refresh();
    const p = this.resolve(ref);
    const add = [...new Set(ids.map(M.parentOf))].filter(id => !p.threads.includes(id));
    if (!add.length) return { project: p.slug, added: [], threads: p.threads.length };
    const next = /** @type {Project} */ (M.write(p.home, { threads: [...p.threads, ...add] }));
    this.refresh();
    for (const id of add) this.emit("thread.picked", { project: p.slug, thread: id }, { project: p.slug, thread: id });
    this.emit("project.changed", { project: p.slug, fields: ["threads"] }, { project: p.slug });
    return { project: p.slug, added: add, threads: next.threads.length };
  }

  /**
   * Attach an existing folder to an existing project as one of its workspaces (Vyre Drive step
   * 4): the folder starts counting as the project's own, the same as one listed at create()
   * time. Person-only (core/presence PERSON_ONLY), the same weight a pick carries: attaching a
   * folder to a project is a placement decision. Mirrors create()'s own workspaces handling
   * exactly (sessions' review of this shape, 2026-09-28): M.relative drops the home folder
   * itself (relative() turns it into "."), and an already-listed folder is left alone rather
   * than duplicated, the same as addThreads dedupes against p.threads.
   */
  addWorkspace(ref, folder) {
    refuseSensitiveRoot(folder);
    this.refresh();
    const p = this.resolve(ref);
    const rel = M.relative(p.home, [folder]).filter(w => w !== ".");
    if (!rel.length) return { project: p.slug, added: null, workspaces: p.workspaces }; // the folder IS the project's home
    const [add] = rel;
    // p.workspaces (loaded) is absolute and home-prefixed; the marker stores relative paths
    // without the home, the same shape create() writes. existing strips the load()-added home
    // (always index 0) and re-derives the relative list, so this never writes p.workspaces'
    // resolved form back onto disk.
    const existing = M.relative(p.home, p.workspaces.slice(1));
    if (existing.includes(add)) return { project: p.slug, added: null, workspaces: p.workspaces };
    const next = /** @type {Project} */ (M.write(p.home, { workspaces: [...existing, add] }));
    this.refresh();
    this.emit("project.changed", { project: p.slug, fields: ["workspaces"] }, { project: p.slug });
    return { project: p.slug, added: add, workspaces: next.workspaces };
  }

  /**
   * Remove picks. A thread that ran in one of the project's folders stays in it by folder; that
   * is a fact about where the work happened, not a choice, so it is reported rather than hidden.
   */
  removeThreads(ref, ids) {
    this.refresh();
    const p = this.resolve(ref);
    const drop = new Set(ids.map(M.parentOf));
    const removed = p.threads.filter(id => drop.has(id));
    if (removed.length) {
      M.write(p.home, { threads: p.threads.filter(id => !drop.has(id)) });
      this.refresh();
      for (const id of removed) this.emit("thread.unpicked", { project: p.slug, thread: id }, { project: p.slug, thread: id });
      this.emit("project.changed", { project: p.slug, fields: ["threads"] }, { project: p.slug });
    }
    const byFolder = this.threadsOf(this.resolve(p.slug)).filter(t => drop.has(t.id) && t.how.includes("folder")).map(t => t.id);
    return { project: p.slug, removed, stillByFolder: byFolder };
  }

  /**
   * Add watchers: names on the marker (spec 7.2) for someone who should hear about this
   * project's Needs without running a session in it — core/waiting's rows already carry
   * `project`, so a surface that knows who watches what can filter on it once this exists.
   * Person-only (core/presence PERSON_ONLY), same shape as addThreads.
   */
  addWatchers(ref, names) {
    this.refresh();
    const p = this.resolve(ref);
    const clean = [...new Set(names.map(n => String(n).trim()).filter(Boolean))];
    const add = clean.filter(n => !p.watchers.includes(n));
    if (!add.length) return { project: p.slug, added: [], watchers: p.watchers };
    const next = /** @type {Project} */ (M.write(p.home, { watchers: [...p.watchers, ...add] }));
    this.refresh();
    this.emit("project.changed", { project: p.slug, fields: ["watchers"] }, { project: p.slug });
    return { project: p.slug, added: add, watchers: next.watchers };
  }

  /** Remove watchers. Removing a name nobody has does nothing and reports no removal. */
  removeWatchers(ref, names) {
    this.refresh();
    const p = this.resolve(ref);
    const drop = new Set(names.map(n => String(n).trim()));
    const removed = p.watchers.filter(n => drop.has(n));
    if (!removed.length) return { project: p.slug, removed: [], watchers: p.watchers };
    const next = /** @type {Project} */ (M.write(p.home, { watchers: p.watchers.filter(n => !drop.has(n)) }));
    this.refresh();
    this.emit("project.changed", { project: p.slug, fields: ["watchers"] }, { project: p.slug });
    return { project: p.slug, removed, watchers: next.watchers };
  }

  // ------------------------------------------------------------ reading sessions

  hasIndex() {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'recall_sessions'").get());
  }

  /**
   * Every top-level session with its subagents folded in. A subagent is work done on its
   * parent's behalf: listing it separately would double every thread that used one.
   */
  sessions() {
    if (!this.hasIndex()) return [];
    const list = this.valid();
    const agents = new Map();
    for (const r of this.db.prepare("SELECT parent, COUNT(*) n, MAX(ended) last FROM recall_sessions WHERE parent IS NOT NULL GROUP BY parent").all()) {
      agents.set(String(r.parent), { n: Number(r.n), last: Number(r.last) || 0 });
    }
    return this.db.prepare("SELECT id, cwd, name, title, started, ended, turns, human FROM recall_sessions WHERE parent IS NULL AND turns > 0").all()
      .map(r => {
        const a = agents.get(String(r.id));
        return {
          id: String(r.id), name: r.name ? String(r.name) : null, title: r.title ? String(r.title) : null,
          label: "", cwd: r.cwd ? String(r.cwd) : null, started: Number(r.started) || 0,
          last: Math.max(Number(r.ended) || 0, a ? a.last : 0), turns: Number(r.turns), human: Number(r.human) === 1,
          agents: a ? a.n : 0,
        };
      })
      // The project whose folders it ran in, worked out once here for every caller.
      .map(r => ({ ...r, label: label(r), folder: M.projectOf(r.cwd, list, { resolved: true })?.slug || null }));
  }

  /** For each session id, the projects it is in and how. */
  membership() {
    const list = this.valid();
    /** @type {Map<string, Map<string, Set<string>>>} */
    const m = new Map();
    const put = (id, slug, how) => {
      if (!m.has(id)) m.set(id, new Map());
      const bySlug = /** @type {Map<string, Set<string>>} */ (m.get(id));
      if (!bySlug.has(slug)) bySlug.set(slug, new Set());
      /** @type {Set<string>} */ (bySlug.get(slug)).add(how);
    };
    for (const p of list) for (const id of p.threads) put(id, p.slug, "picked");
    for (const s of this.sessions()) if (s.folder) put(s.id, s.folder, "folder");
    return m;
  }

  /** The threads of one project, newest first, each saying how it belongs. */
  threadsOf(p, { exclude = null } = {}) {
    const picked = new Set(p.threads);
    const out = [];
    const seen = new Set();
    for (const s of this.sessions()) {
      const how = [];
      if (picked.has(s.id)) how.push("picked");
      if (s.folder === p.slug) how.push("folder");
      if (how.length && s.id !== exclude) out.push({ ...s, how });
      seen.add(s.id);
    }
    out.sort((a, b) => b.last - a.last);
    // A pick the index has not seen yet (not indexed, or its transcript is gone) is still a pick.
    for (const id of p.threads) if (!seen.has(id) && id !== exclude) {
      out.push({ id, name: null, title: null, label: id, cwd: null, started: 0, last: 0, turns: 0, human: true, agents: 0, how: ["picked"], missing: true });
    }
    return out;
  }

  // ------------------------------------------------------------ the catalogue

  /**
   * Every session on the device, for picking. A session matches a search when every word is in
   * its name, first message or folder, OR when Recall finds the words in what was said. Most work
   * happens inside long sessions named for something else entirely, so a picker that searched
   * only titles would hide most of it. Title matches first, then by how often it was said, then
   * newest.
   */
  async catalog({ q = "", limit = 50, human } = {}) {
    this.refresh();
    const member = this.membership();
    let rows = this.sessions();
    if (human !== undefined) rows = rows.filter(r => r.human === human);
    const withProjects = r => ({ ...r, projects: [...(member.get(r.id)?.keys() || [])] });
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const note = !this.hasIndex() ? "No sessions are indexed yet. Recall builds the index when it runs." : undefined;
    if (!words.length) {
      rows.sort((a, b) => b.last - a.last);
      return { total: rows.length, search: "none", ...(note ? { note } : {}), sessions: rows.slice(0, limit).map(withProjects) };
    }
    /** @type {Map<string, number>} */
    const said = new Map();
    let search = "said";
    let why;
    // One call per search, whatever the size of the index: Recall caps a search at 100 turns.
    const r = await this.call("recall.search", { q: words.join(" "), limit: 100 });
    if (r.error) {
      search = "titles";
      why = r.error.code === "no_such_tool"
        ? "Recall is not running, so this searched names, first messages and folders only."
        : `Recall could not search (${r.error.message}), so this searched names, first messages and folders only.`;
    } else {
      const hits = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.hits) ? r.data.hits : [];
      for (const h of hits) if (h && h.session) { const id = M.parentOf(h.session); said.set(id, (said.get(id) || 0) + 1); }
    }
    const out = [];
    for (const row of rows) {
      const hay = [row.name, row.title, row.cwd].join(" ").toLowerCase();
      const titled = words.every(w => hay.includes(w));
      const n = said.get(row.id) || 0;
      if (titled || n) out.push({ ...row, titled, said: n });
    }
    out.sort((a, b) => Number(b.titled) - Number(a.titled) || b.said - a.said || b.last - a.last);
    return { total: out.length, search, ...(why || note ? { note: why || note } : {}), sessions: out.slice(0, limit).map(withProjects) };
  }

  // ------------------------------------------------------------ what a folder is, what a thread is told

  /** The project that owns a folder, or null. */
  of(cwd) {
    this.refresh();
    return M.projectOf(cwd, this.valid());
  }

  /**
   * Which project a starting thread is in: the one named, else the one that owns its folder,
   * else the one it was picked into. A thread picked into several projects, started outside all
   * of them, gets no brief rather than a guess: telling Claude it is in the wrong client's
   * project is worse than telling it nothing.
   */
  which({ project, cwd, session }) {
    this.refresh();
    if (project) return { project: this.resolve(project), candidates: [] };
    const byCwd = M.projectOf(cwd, this.valid());
    if (byCwd) return { project: byCwd, candidates: [] };
    if (session) {
      const id = M.parentOf(session);
      const picked = this.valid().filter(p => p.threads.includes(id));
      if (picked.length === 1) return { project: picked[0], candidates: [] };
      return { project: null, candidates: picked.map(p => p.slug) };
    }
    return { project: null, candidates: [] };
  }

  /** The brief for a project as plain text, from that project's data only. */
  async context({ project, cwd, session }) {
    const w = this.which({ project, cwd, session });
    if (!w.project) return { project: null, candidates: w.candidates, text: "" };
    const p = w.project;
    const threads = this.threadsOf(p, { exclude: session ? M.parentOf(session) : null }).filter(t => !t.missing);
    let facts = [];
    // Only the project's own folders: a hub session picked into it ran somewhere shared, and
    // asking for that folder's facts would bring the other projects' memory in with it.
    // The project's room by slug: its folders alone could name a project that holds this one.
    const r = await this.call("memory.facts", { room: p.slug, project_cwds: p.workspaces, limit: 10 });
    if (!r.error) facts = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.facts) ? r.data.facts : [];
    const text = compose({ project: p, threads, facts });
    return { project: p.slug, candidates: [], text };
  }

  /** Projects for the list: newest activity first. */
  list({ walk = true } = {}) {
    const list = this.refresh({ walk });
    const member = this.membership();
    const sessions = new Map(this.sessions().map(s => [s.id, s]));
    const out = list.map(p => {
      let picked = 0, folder = 0, last = 0;
      for (const [id, bySlug] of member) {
        const how = bySlug.get(p.slug);
        if (!how) continue;
        if (how.has("picked")) picked++; else folder++;
        last = Math.max(last, sessions.get(id)?.last || 0);
      }
      // picks: the picked session ids themselves (subagents folded to their parent), for Memory's
      // rooms. threads and picked stay counts: the CLI and the Deck print them.
      return { slug: p.slug, name: p.name, org: p.org, home: p.home, workspaces: p.workspaces, people: p.people,
        watchers: p.watchers, threads: picked + folder, picked, folder, picks: [...new Set(p.threads.map(M.parentOf))], last };
    });
    out.sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
    const problems = this.all.filter(p => p.error).map(p => ({ home: p.home, error: p.error }));
    return { projects: out, problems };
  }
}
