// @ts-check
// The Project hub (team/0.3/DESIGN-project-hub.md): a Project is one record, and every session is a record linked to it. This is the writing side, in the work module (it already holds a kernel
// handle and writes records under its own service chain).
//
// The INDEX is what must be exact: every project and every session, with its ids, its start and end times, its Drive folder, and where its transcript file is (which machine, which path) plus the kernel
// address the transcript and checkpoints are kept under. A summary text is optional and, when there is none, a plain line of facts. Nothing here holds transcript text.
//
//   createProject(chain, { name, repo?, client? })    the record, its short name, its Drive folder NAMED BY ITS ID (Projects/<id>: a rename never touches Drive), its memory scope
//   generalProject()                                  the Space's default project: a session started with no project lands here
//   onStarted / onStopped                             the switchboard's and the Harness's session events, as a session summary record linked to its Project
//   moveSession(thread, project, by)                  "Move to project": the record's link, and the session's two Drive folders moved under the other project, as the person who moved it
//   renameProject / renameSession                     a name changed anywhere reaches every other place (the record, the old project list, the thread), ids unchanged; Drive is never touched
//
// Renames settle because each side compares before it writes: a side that already has the new name does nothing, so two sides that both sync names cannot ping-pong.

import os from "node:os";
import { slugify, SLUG_RE } from "../../lib/project-id.js";

const PROJECT = "project", SUMMARY = "session-summary", GENERAL = "general";
/** Fields only the system writes: a person's edit of one is put back, so a record edit can never point the hub at another folder or session. */
const SYSTEM_FIELDS = { [PROJECT]: ["slug", "drive_path", "memory_scope"], [SUMMARY]: ["thread", "transcript", "transcript_file", "machine", "drive", "started", "ended"] };
/** The only part of the Drive the hub ever moves. */
const underProjects = (/** @type {any} */ p) => typeof p === "string" && /^Projects\/[^/]+(?:\/[^/]+)*$/.test(p) && !p.split("/").some(x => x === ".." || x === ".");

/**
 * @param {{ kernel: any, call?: (tool: string, input: any) => Promise<any>, now?: () => number, machine?: string, log?: (m: string) => void }} o
 */
export function createHub({ kernel, call, now = Date.now, machine = os.hostname(), log = () => {} }) {
  const chain = () => kernel.serviceChain("work");
  const iso = (/** @type {number} */ t) => new Date(t).toISOString();
  const urnOf = (/** @type {string} */ type, /** @type {string} */ id) => `vyre://${kernel.space}/${type}/${id}`;
  const find = async (/** @type {string} */ type, /** @type {string} */ field, /** @type {any} */ value) => (await kernel.records.query(chain(), type, { filter: { field, op: "eq", value }, page: { limit: 1 } })).rows[0] || null;
  const data = (/** @type {any} */ r) => { const d = r && (r.data !== undefined ? r.data : r); return d && d.data !== undefined && d.id === undefined ? d.data : d; };
  const tool = async (/** @type {string} */ name, /** @type {any} */ input) => { if (!call) return null; try { const r = await call(name, input); return r && r.data !== undefined ? r.data : r; } catch { return null; } };

  /** A slug no Project has yet: the name's own, then `-2`, `-3`. @param {string} name */
  async function freeSlug(name) {
    const base = slugify(name) || "project";
    for (let n = 1; n < 1000; n++) { const s = n === 1 ? base : `${base}-${n}`; if (!(await find(PROJECT, "slug", s))) return s; }
    throw Object.assign(new Error("could not find a free short name for this project"), { code: "conflict" });
  }
  /** @param {any} caller the chain the record is made under (the person's own); the folder marker is the service's */
  async function createProject(caller, { name, repo, client, slug }) {
    const nm = String(name || "").trim();
    if (!nm || nm.length > 120) throw Object.assign(new Error("a project has a name of up to 120 characters"), { code: "bad_input" });
    if (slug !== undefined && !(typeof slug === "string" && SLUG_RE.test(slug))) throw Object.assign(new Error("the short name is lower case letters, numbers and dashes"), { code: "bad_input" });
    if (slug !== undefined && (await find(PROJECT, "slug", slug))) throw Object.assign(new Error("a project already has that short name"), { code: "conflict" });
    const s = slug || await freeSlug(nm);
    const made = await kernel.records.create(caller || chain(), PROJECT, { name: nm, slug: s, status: "active", memory_scope: `project:${s}`, ...(repo ? { repo: String(repo).slice(0, 300) } : {}), ...(client ? { client: { urn: String(client) } } : {}) });
    // the folder is named by the record's own id, which never changes: a rename never touches Drive. The hub writes this field; a person's edit of it is put back.
    const rec = await kernel.records.update(chain(), PROJECT, made.id, { drive_path: `Projects/${made.id}` }, made.version);
    // The marker is the CALLER's own write (drive.write on its chain): a person who cannot write Drive cannot make a project, and the record is taken back so none is left half made.
    try { await folderMarker(rec, caller || chain(), true); }
    catch (e) { await kernel.records.remove(caller || chain(), PROJECT, rec.id).catch(() => {}); throw e; }
    return rec;
  }

  /** Drive has path prefixes, not folders: a folder exists when a file does. The marker is the record's own address, so the folder is there and says what it is for. @param {any} rec */
  async function folderMarker(rec, by = chain(), strict = false) {
    if (!kernel.drive || typeof kernel.drive.put !== "function") return;
    try { await kernel.drive.put(by, `${rec.data.drive_path}/.project`, new TextEncoder().encode(`${rec.urn}\n`)); }
    catch (e) { if (strict) throw e; log(`project hub: no Drive folder marker for ${rec.data.slug} (${/** @type {Error} */ (e).message})`); }
  }

  /** The Project for a slug an older part of the system still names; made from the folder project's name on first sight. @param {string} slug @param {string} [name] */
  async function ensureProject(slug, name) {
    if (!slug || !SLUG_RE.test(slug)) return null;
    const have = await find(PROJECT, "slug", slug);
    if (have) return have;
    let nm = name;
    if (!nm) { const r = await tool("projects.list", {}); const list = (r && r.projects) || []; const hit = Array.isArray(list) ? list.find((/** @type {any} */ p) => p.slug === slug) : null; if (hit) nm = hit.name; }
    return createProject(chain(), { name: nm || slug, slug });
  }

  /** The Space's default project, "General": made on first need. A session started without a project is filed here, and "Move to project" files it later. */
  /** @type {Promise<any> | null} */ let generalOnce = null;
  const generalProject = () => (generalOnce ||= (async () => (await find(PROJECT, "slug", GENERAL)) || createProject(chain(), { name: "General", slug: GENERAL }))().catch(e => { generalOnce = null; throw e; }));
  /** A Project's Drive folder: its own field, or (in the instant between its creation and the hub setting it) the same id-named path. @param {any} proj */
  const rootOf = proj => proj.data.drive_path || `Projects/${proj.id}`;

  /** Where a session's transcript file is on this machine, from the index of sessions Recall keeps. @param {string} thread */
  async function transcriptFile(thread) {
    const r = await tool("recall.sessions", { ids: [thread], limit: 1, machines: "local" });
    const row = Array.isArray(r) ? r[0] : null;
    return row && typeof row.file === "string" ? row.file : null;
  }

  /** @param {any} p0 the thread.started payload ({ thread, name, cwd, project, agent, provider, model, ... }); the Harness's hook says `session` and knows only the folder */
  async function onStarted(p0) {
    let p = p0 && typeof p0.thread !== "string" && typeof p0.session === "string" ? { ...p0, thread: p0.session } : p0;
    if (!p || typeof p.thread !== "string") return null;
    try {
      if (!p.project && typeof p.cwd === "string") { const hit = await tool("projects.of", { cwd: p.cwd }); if (hit && typeof hit.slug === "string") p = { ...p, project: hit.slug }; }
      const have = await find(SUMMARY, "thread", p.thread);
      const file = await transcriptFile(p.thread);
      if (have) {
        // a resumed session, or the second of two events for one (the switchboard and the Harness hook): the same record, working, with what it did not know before filled in
        const proj0 = !have.data.project ? (p.project ? await ensureProject(String(p.project)).catch(() => null) : await generalProject().catch(() => null)) : null;
        const fill = { status: "working", ended: null, ...(proj0 ? { project: { urn: proj0.urn }, drive: rootOf(proj0) } : {}), ...(!have.data.model && p.model ? { model: String(p.model) } : {}), ...(!have.data.provider && p.provider ? { provider: String(p.provider) } : {}), ...(!have.data.agents && p.agent ? { agents: String(p.agent) } : {}),
          ...(p.name && (!have.data.title || /session$/i.test(have.data.title)) ? { title: String(p.name).slice(0, 120) } : {}), ...(file && !have.data.transcript_file ? { transcript_file: file, machine } : {}) };
        return kernel.records.update(chain(), SUMMARY, have.id, fill, have.version);
      }
      // every session belongs to a project: the one it ran in, else General
      const proj = (p.project ? await ensureProject(String(p.project)).catch(() => null) : null) || await generalProject().catch(() => null);
      let acct = null;
      const t = (await tool("threads.get", { thread: p.thread, limit: 1 }) || {}).thread;
      if (t && t.account) acct = t.account;
      return await kernel.records.create(chain(), SUMMARY, {
        title: String(p.name || (p.agent ? `${p.agent} session` : "Session")).slice(0, 120), ...(proj ? { project: { urn: proj.urn }, drive: rootOf(proj) } : {}),
        people: String(kernel.owner || ""), ...(p.agent ? { agents: String(p.agent) } : {}), ...(p.provider ? { provider: String(p.provider) } : {}), ...(p.model ? { model: String(p.model) } : {}), ...(acct ? { account: String(acct) } : {}),
        started: iso(now()), status: "working", thread: p.thread, transcript: urnOf("session", p.thread), ...(file ? { transcript_file: file, machine } : { machine }),
      });
    } catch (e) { log(`project hub: could not write the session record for ${p.thread}: ${/** @type {Error} */ (e).message}`); return null; }
  }

  /** @param {any} p0 the thread.stopped payload ({ thread, code, reason }) */
  async function onStopped(p0) {
    const p = p0 && typeof p0.thread !== "string" && typeof p0.session === "string" ? { ...p0, thread: p0.session } : p0;
    if (!p || typeof p.thread !== "string") return null;
    try {
      const have = await find(SUMMARY, "thread", p.thread);
      if (!have || have.data.status !== "working") return null; // closed already (the switchboard and the terminal hook can both say it)
      const t = (await tool("threads.get", { thread: p.thread, limit: 1 }) || {}).thread;
      const reason = String(p.reason || "");
      const status = /^exited \d/.test(reason) || reason === "restart" || /without starting/.test(reason) ? "failed" : reason === "stopped" ? "stopped" : "done";
      const turns = t && Number.isFinite(t.turns) ? t.turns : null;
      const facts = `${turns === null ? "A session" : `${turns} turn${turns === 1 ? "" : "s"}`}${have.data.model ? ` on ${have.data.model}` : ""}${reason ? `, ended: ${reason.slice(0, 80)}` : ""}.`;
      await syncNameFromTranscript(p.thread);
      const have2 = await find(SUMMARY, "thread", p.thread) || have;
      const file = have2.data.transcript_file ? null : await transcriptFile(p.thread);
      return await kernel.records.update(chain(), SUMMARY, have.id, { status, ended: iso(now()), summary: facts.slice(0, 1500), ...(t && t.model ? { model: String(t.model) } : {}), ...(file ? { transcript_file: file, machine } : {}) }, have2.version);
    } catch (e) { log(`project hub: could not close the session record for ${p.thread}: ${/** @type {Error} */ (e).message}`); return null; }
  }

  /** A session's folder name: its id, which never changes (so a rename never touches Drive). Under its project's folder there are two: what the person dropped in (`chat`) and what a model made (`made`). */
  const sessionFolder = (/** @type {any} */ rec) => String(rec.data.thread);
  const KINDS = ["chat", "made"];
  /** Move a session's two folders under another project's folder, as the PERSON who moved it: the gateway checks drive.read and drive.write on every file and aborts the whole move on one refusal. A missing folder moves nothing. */
  async function moveSessionFolders(by, /** @type {string} */ fromRoot, /** @type {string} */ name, /** @type {string} */ toRoot) {
    if (!kernel.drive || typeof kernel.drive.moveFolders !== "function" || fromRoot === toRoot) return;
    if (!underProjects(fromRoot) || !underProjects(toRoot)) return;
    // both folders are checked, file by file, before either moves: a session is never left split across two projects
    await kernel.drive.moveFolders(by, KINDS.map(k => [`${fromRoot}/${k}/${name}`, `${toRoot}/${k}/${name}`]));
  }

  /** The Project a reference names: a short name, or a record address. @param {string} ref */
  async function projectOf(ref) {
    const r = String(ref || "");
    if (r.startsWith("vyre://")) { const [, , , type, id] = r.split("/"); return type === PROJECT ? kernel.records.get(chain(), PROJECT, id) : null; }
    return find(PROJECT, "slug", r);
  }

  /** "Move to project": the session's record is linked to the other Project and carries its Drive folder; its ids, times and transcript pointer stay exactly as they were. */
  async function moveSession(thread, projectRef, by) {
    if (!by) throw Object.assign(new Error("a session is moved by a person"), { code: "not_allowed" });
    const rec = await find(SUMMARY, "thread", thread);
    if (!rec) throw Object.assign(new Error("no record of that session"), { code: "not_found" });
    const proj = await projectOf(projectRef);
    if (!proj) throw Object.assign(new Error("no such project"), { code: "not_found" });
    if (rec.data.project && rec.data.project.urn === proj.urn) return rec;
    // the files first, as the person who moves it: a refused file aborts everything and nothing has changed
    if (rec.data.drive && rec.data.drive !== rootOf(proj)) await moveSessionFolders(by, rec.data.drive, sessionFolder(rec), rootOf(proj));
    const moved = await kernel.records.update(by, SUMMARY, rec.id, { project: { urn: proj.urn }, drive: rootOf(proj) }, rec.version);
    // the old folder list still counts the session as picked into the project it was in
    const oldSlug = rec.data.project && rec.data.project.urn ? (await projectOf(rec.data.project.urn).catch(() => null)) : null;
    await tool("projects.remove-threads", { project: oldSlug && oldSlug.data.slug, threads: [thread] });
    await tool("projects.add-threads", { project: proj.data.slug, threads: [thread] });
    return moved;
  }

  /**
   * A Project's name changed somewhere. The record's name and the old project list take it; Drive is never touched (the folder is named by the project's id). Ids never change. `from` says where
   * the change came from, so that place is not written back to.
   * @param {any} rec the Project record @param {string} name @param {"record" | "list"} from
   */
  async function renameProject(rec, name, from, by = chain()) {
    const nm = String(name || "").trim();
    if (!nm || nm.length > 120) return rec;
    let cur = rec;
    if (cur.data.name !== nm) cur = await kernel.records.update(by, PROJECT, cur.id, { name: nm }, cur.version);
    if (from !== "list" && cur.data.slug) { const l = await tool("projects.list", {}); const hit = ((l && l.projects) || []).find((/** @type {any} */ p) => p.slug === cur.data.slug); if (hit && hit.name !== nm) await tool("projects.rename", { project: cur.data.slug, name: nm }); }
    return cur;
  }

  /** A session's name changed somewhere: the record's title and the thread's name agree. @param {any} rec the session record @param {string} title @param {"record" | "thread"} from */
  async function renameSession(rec, title, from, by = chain()) {
    const t = String(title || "").trim().slice(0, 120);
    if (!t) return rec;
    let cur = rec;
    if (cur.data.title !== t) cur = await kernel.records.update(by, SUMMARY, cur.id, { title: t }, cur.version);
    if (from !== "thread" && cur.data.thread) await tool("threads.rename", { thread: cur.data.thread, name: t });
    return cur;
  }

  /** The last name the transcript showed for each session, so only a CHANGE in it counts as a rename (a stale transcript name never overwrites a title set in Records). @type {Map<string, string>} */
  const seenName = new Map();
  /**
   * A /rename inside Claude Code lands in the transcript, which Recall indexes as the session's name. At each turn's end (and at the session's end) a name that differs from the one last seen
   * is a rename made there, and the record's title follows. The first look only records the name.
   * @param {string} thread
   */
  async function syncNameFromTranscript(thread) {
    try {
      const rec = await find(SUMMARY, "thread", thread);
      if (!rec) return null;
      const r = await tool("recall.sessions", { ids: [thread], limit: 1, machines: "local" });
      const row = Array.isArray(r) ? r[0] : null;
      const name = row && typeof row.name === "string" ? row.name.trim() : "";
      if (!name) return null;
      const before = seenName.get(thread);
      seenName.set(thread, name);
      if (before === undefined) return name !== rec.data.title && !rec.data.title ? renameSession(rec, name, "thread") : null;
      return before !== name ? renameSession(rec, name, "thread") : null;
    } catch (e) { log(`project hub: could not read the transcript's name for ${thread}: ${/** @type {Error} */ (e).message}`); return null; }
  }
  const onTurn = async (/** @type {any} */ p) => (p && typeof p.session === "string" ? syncNameFromTranscript(p.session) : null);

  /** Events that carry a name change from the other sides: the old project list's `project.changed` and the thread's `thread.renamed`. */
  async function onProjectChanged(p) {
    if (!p || typeof p.project !== "string" || typeof p.name !== "string") return null;
    try { const rec = await find(PROJECT, "slug", p.project); return rec ? await renameProject(rec, p.name, "list") : null; } catch (e) { log(`project hub: rename of ${p.project} did not reach Records: ${/** @type {Error} */ (e).message}`); return null; }
  }
  async function onThreadRenamed(p) {
    if (!p || typeof p.thread !== "string" || typeof p.name !== "string") return null;
    try { const rec = await find(SUMMARY, "thread", p.thread); return rec ? await renameSession(rec, p.name, "thread") : null; } catch (e) { log(`project hub: rename of ${p.thread} did not reach Records: ${/** @type {Error} */ (e).message}`); return null; }
  }
  /**
   * A record changed in Records itself. A person's edit of a system field is put back and nothing else happens. A name change is only a title: anyone allowed to update the record may rename, and it reaches the project
   * list and the thread for them. Nothing here touches Drive: folders are named by id, so a rename moves nothing.
   * @param {any} ev a kernel event ({ type, subject, actor, data: { changed, before, after } })
   */
  async function onRecordChanged(ev) {
    try {
      const m = /^vyre:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(String(ev && ev.subject));
      if (!m || (m[1] !== PROJECT && m[1] !== SUMMARY)) return null;
      const changed = ev.data && Array.isArray(ev.data.changed) ? ev.data.changed : [];
      const mine = /^service:work@/.test(String(ev.actor || ""));
      let rec = await kernel.records.get(chain(), m[1], m[2]);
      if (!rec) return null;
      const bad = mine ? [] : SYSTEM_FIELDS[/** @type {"project"} */ (m[1])].filter(f => changed.includes(f));
      if (bad.length) {
        const before = (ev.data && ev.data.before) || {};
        const patch = Object.fromEntries(bad.map(f => [f, before[f] === undefined ? null : before[f]]));
        log(`project hub: put back ${bad.join(", ")} on ${ev.subject}, which only the system writes`);
        return await kernel.records.update(chain(), m[1], m[2], patch, rec.version);
      }
      if (mine) return null;
      if (m[1] === PROJECT && changed.includes("name")) return await renameProject(rec, rec.data.name, "record");
      if (m[1] === SUMMARY && changed.includes("title")) return await renameSession(rec, rec.data.title, "record");
    } catch (e) { log(`project hub: a change in Records did not reach its other places: ${/** @type {Error} */ (e).message}`); }
    return null;
  }

  return Object.freeze({ createProject, ensureProject, generalProject, onStarted, onStopped, moveSession, renameProject, renameSession, onProjectChanged, onThreadRenamed, onRecordChanged, onTurn, syncNameFromTranscript, freeSlug, projectOf, sessionFolder, sessionRecord: (/** @type {string} */ thread) => find(SUMMARY, "thread", thread) });
}
