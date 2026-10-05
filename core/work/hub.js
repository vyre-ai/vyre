// @ts-check
// The Project hub (team/0.3/DESIGN-project-hub.md) and the Chat record (DESIGN-one-chat.md, CONTRACT-one-chat.md): a Project is one record, and every chat is a record linked to it. This is the writing
// side, in the work module (it already holds a kernel handle and writes records under its own service chain).
//
// A Chat record holds only what an admin may see: that the chat exists, its title, who is in it (a mirror of the kernel's list), when, its status and where it lives. Never messages, transcripts, models,
// providers or a summary; those are the engine's and come back to participants through `work.chat.get`. The INDEX is what must be exact: every chat with its kernel id, times and Drive folder.
//
//   createProject(chain, { name, repo?, client? })    the record, its short name, its Drive folder NAMED BY ITS ID (Projects/<id>: a rename never touches Drive), its memory scope
//   generalProject()                                  the Space's default project: a chat started with no project lands here
//   onChatCreated / onChatChanged                     the kernel's `chat.created` and `chat.changed`: the record and its mirrored people and agents
//   onStarted / onChatLinked / onStopped              the switchboard's and the Harness's run events: title, project, status, last active
//   moveChat(chat, project, by)                       "Move to project": the record's link, and the chat's two Drive folders moved under the other project, as the person who moved it
//   renameProject / renameChat                        a name changed anywhere reaches every other place (the record, the old project list, every run's name), ids unchanged; Drive is never touched
//
// Renames settle because each side compares before it writes: a side that already has the new name does nothing, so two sides that both sync names cannot ping-pong.

import os from "node:os";
import { slugify, SLUG_RE } from "../../lib/project-id.js";

const PROJECT = "project", CHAT = "chat-record", GENERAL = "general", UNTITLED = "New chat";
/** Fields only the system writes: a person's edit of one is put back, so a record edit can never point the hub at another folder or session. */
const SYSTEM_FIELDS = { [PROJECT]: ["slug", "drive_path", "memory_scope"], [CHAT]: ["chat", "people", "agents", "former", "started", "last_active", "status", "drive", "location"] };
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
    // A Basic personal space (no server, no Drive) keeps its projects as plain folders on this device: the record's `drive_path` is that device folder, learned when this computer adopts the
    // project. With a Drive, the folder is named by the record's own id, which never changes: a rename never touches Drive. The hub writes this field; a person's edit of it is put back.
    const plain = !kernel.drive;
    let rec = plain ? made : await kernel.records.update(chain(), PROJECT, made.id, { drive_path: `Projects/${made.id}` }, made.version);
    // The marker is the CALLER's own write (drive.write on its chain): a person who cannot write Drive cannot make a project, and the record is taken back so none is left half made.
    try { await folderMarker(rec, caller || chain(), true); }
    catch (e) { await kernel.records.remove(caller || chain(), PROJECT, rec.id).catch(() => {}); throw e; }
    // this computer learns of it: a local row and a home folder for the sessions that start here
    const adopted = await tool("projects.adopt", { slug: s, name: nm });
    if (plain && adopted && typeof adopted.home === "string" && adopted.home) rec = await kernel.records.update(chain(), PROJECT, made.id, { drive_path: adopted.home }, made.version);
    return rec;
  }

  /** Drive has path prefixes, not folders: a folder exists when a file does. The marker is the record's own address, so the folder is there and says what it is for. @param {any} rec */
  async function folderMarker(rec, by = chain(), strict = false) {
    if (!kernel.drive || typeof kernel.drive.put !== "function") return;
    try { await kernel.drive.put(by, `${rec.data.drive_path}/.project`, new TextEncoder().encode(`${rec.urn}\n`)); }
    catch (e) { if (strict) throw e; log(`project hub: no Drive folder marker for ${rec.data.slug} (${/** @type {Error} */ (e).message})`); }
  }

  /** @type {Map<string, Promise<any>>} one in flight per short name: the project list's event and the projects module's own ask can both arrive at once, and a short name is unique */
  const making = new Map();
  /** The Project for a slug an older part of the system still names; made from the folder project's name on first sight. @param {string} slug @param {string} [name] */
  function ensureProject(slug, name) {
    if (!slug || !SLUG_RE.test(slug)) return Promise.resolve(null);
    const hit = making.get(slug);
    if (hit) return hit;
    const p = (async () => {
      const have = await find(PROJECT, "slug", slug);
      if (have) return have;
      let nm = name;
      if (!nm) { const r = await tool("projects.list", {}); const list = (r && r.projects) || []; const h = Array.isArray(list) ? list.find((/** @type {any} */ x) => x.slug === slug) : null; if (h) nm = h.name; }
      return createProject(chain(), { name: nm || slug, slug });
    })().finally(() => making.delete(slug));
    making.set(slug, p);
    return p;
  }

  /** The Space's default project, "General": made on first need. A session started without a project is filed here, and "Move to project" files it later. */
  /** @type {Promise<any> | null} */ let generalOnce = null;
  const generalProject = () => (generalOnce ||= (async () => (await find(PROJECT, "slug", GENERAL)) || createProject(chain(), { name: "General", slug: GENERAL }))().catch(e => { generalOnce = null; throw e; }));
  /** A Project's Drive folder: its own field, or (in the instant between its creation and the hub setting it) the same id-named path. @param {any} proj */
  const rootOf = proj => proj.data.drive_path || (kernel.drive ? `Projects/${proj.id}` : "");

  /** One write at a time per chat: a run's events arrive close together (started, working, waiting), each handler reads the record and writes it back, and two at once would lose one. @type {Map<string, Promise<any>>} */
  const lanes = new Map();
  const serial = (/** @type {string} */ chat, /** @type {() => Promise<any>} */ f) => { const p = (lanes.get(chat) || Promise.resolve()).then(f, f); lanes.set(chat, p.catch(() => {})); return p; };
  const ids = (/** @type {any} */ l) => (Array.isArray(l) ? l : []).map(String).join(",");
  const findChat = (/** @type {string} */ chat) => find(CHAT, "chat", chat);
  const rootOf2 = (/** @type {any} */ proj) => rootOf(proj);
  const locationOf = (/** @type {any} */ proj, /** @type {string} */ chat) => `${rootOf2(proj)}/chat/${chat}/`;

  /**
   * The record of a chat, made when first heard of (the kernel's `chat.created`, or a run's start, whichever comes first) and filled by the other. `hints` is what the sender knows.
   * @param {string} chat @param {{ people?: string[], agents?: string[], title?: string | null, project?: string | null, at?: number }} [hints]
   */
  async function ensureChatRecord(chat, hints = {}) {
    if (typeof chat !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(chat)) return null;
    const have = await findChat(chat);
    if (have) return have;
    const proj = (hints.project ? await ensureProject(String(hints.project)).catch(() => null) : null) || await generalProject();
    const at = iso(hints.at || now());
    try {
      return await kernel.records.create(chain(), CHAT, { title: String(hints.title || UNTITLED).slice(0, 120), project: { urn: proj.urn }, chat, people: ids(hints.people), agents: ids(hints.agents),
        started: at, last_active: at, status: "idle", drive: rootOf(proj), location: locationOf(proj, chat) });
    } catch (e) { const again = await findChat(chat); if (again) return again; throw e; }
  }

  /** The kernel's `chat.created`: { chat: { id, people, assistants } }. @param {any} ev */
  async function onChatCreated(ev) {
    const c = ev && ev.data && ev.data.chat;
    if (!c || typeof c.id !== "string") return null;
    try {
      const rec = await ensureChatRecord(c.id, { people: c.people, agents: c.assistants });
      return rec && (rec.data.people !== ids(c.people) || rec.data.agents !== ids(c.assistants)) ? await kernel.records.update(chain(), CHAT, rec.id, { people: ids(c.people), agents: ids(c.assistants) }, rec.version) : rec;
    } catch (e) { log(`chat record: could not write the record for ${c.id}: ${/** @type {Error} */ (e).message}`); return null; }
  }
  /** The kernel's `chat.changed`: { id, people, assistants }. The mirror follows; kernel membership is never written from here. @param {any} ev */
  async function onChatChanged(ev) {
    const d = ev && ev.data;
    if (!d || typeof d.id !== "string") return null;
    try {
      const rec = await ensureChatRecord(d.id, { people: d.people, agents: d.assistants });
      if (!rec || (rec.data.people === ids(d.people) && rec.data.agents === ids(d.assistants))) return rec;
      return await kernel.records.update(chain(), CHAT, rec.id, { people: ids(d.people), agents: ids(d.assistants), last_active: iso(now()) }, rec.version);
    } catch (e) { log(`chat record: could not follow ${d.id}: ${/** @type {Error} */ (e).message}`); return null; }
  }

  /** A run began in a chat (the switchboard's `thread.started`, which says its chat, name, project and cwd). The chat is working; an untitled one takes the run's name; a chat still in General takes the run's project. @param {any} p */
  async function onStarted(p) {
    if (!p || typeof p.chat !== "string") return null;
    return serial(p.chat, () => startedNow(p));
  }
  async function startedNow(/** @type {any} */ p) {
    try {
      let project = p.project ? String(p.project) : null;
      if (!project && typeof p.cwd === "string") { const hit = await tool("projects.of", { cwd: p.cwd }); if (hit && typeof hit.slug === "string") project = hit.slug; }
      const rec = await ensureChatRecord(p.chat, { title: p.name || null, project, people: [String(kernel.owner || "")].filter(Boolean), agents: [] });
      return rec ? await touch(rec, { status: "working", project, title: p.name || null }) : null;
    } catch (e) { log(`chat record: could not write the record for ${p.chat}: ${/** @type {Error} */ (e).message}`); return null; }
  }
  /** A terminal session's chat was made (`thread.chat`: { session, chat, cwd }): the same as a start. @param {any} p */
  async function onChatLinked(p) { return p && typeof p.chat === "string" ? onStarted({ chat: p.chat, cwd: p.cwd, name: null }) : null; }

  /** Fill a chat record with what a run event knows: working or idle, last active, and the title or project it did not have. @param {any} rec @param {{ status?: string, project?: string | null, title?: string | null }} o */
  async function touch(rec, o) {
    /** @type {any} */ const patch = { last_active: iso(now()) };
    if (o.status && rec.data.status !== o.status) patch.status = o.status;
    if (o.title && (!rec.data.title || rec.data.title === UNTITLED)) patch.title = String(o.title).slice(0, 120);
    if (o.project) {
      const general = await generalProject().catch(() => null);
      const cur = rec.data.project && rec.data.project.urn;
      if (general && cur === general.urn) { const proj = await ensureProject(o.project).catch(() => null); if (proj && proj.urn !== general.urn) Object.assign(patch, { project: { urn: proj.urn }, drive: rootOf(proj), location: locationOf(proj, rec.data.chat) }); }
    }
    return kernel.records.update(chain(), CHAT, rec.id, patch, rec.version);
  }

  /**
   * The chat's status from its runs, by what each says now: working while any run is working, asking or starting; else stopped or failed when every run has ended that way (failed if any failed);
   * else idle (a run that finished its turn and waits for the person). `hint` is used only when the engine cannot be asked. @param {any} rec @param {string} [hint]
   */
  async function refresh(rec, hint) {
    const runs = ((await tool("threads.of-chat", { chat: rec.data.chat })) || {}).runs;
    let status = hint || "idle";
    if (Array.isArray(runs) && runs.length) {
      const st = runs.map((/** @type {any} */ r) => String(r.status));
      if (st.some((/** @type {string} */ x) => ["starting", "working", "asking"].includes(x))) status = "working";
      else if (st.every((/** @type {string} */ x) => ["stopped", "failed"].includes(x))) status = st.includes("failed") ? "failed" : "stopped";
      else status = "idle";
    }
    return touch(rec, { status });
  }

  /** A run's status changed (`thread.status`, which says its chat): the chat's follows. @param {any} p */
  async function onStatus(p) {
    if (!p || typeof p.chat !== "string") return null;
    return serial(p.chat, async () => {
      try { const rec = await findChat(p.chat); return rec ? await refresh(rec, ["working", "starting", "asking"].includes(String(p.status)) ? "working" : undefined) : null; }
      catch (e) { log(`chat record: could not follow ${p.chat}: ${/** @type {Error} */ (e).message}`); return null; }
    });
  }

  /** A run ended (`thread.stopped`: { thread, chat, code, reason }): the chat's status is worked out again from its runs. @param {any} p0 */
  async function onStopped(p0) {
    const p = p0 && typeof p0.thread !== "string" && typeof p0.session === "string" ? { ...p0, thread: p0.session } : p0;
    if (!p || typeof p.thread !== "string") return null;
    try {
      const chat = typeof p.chat === "string" ? p.chat : await chatOfThread(p.thread);
      if (!chat) return null;
      const reason = String(p.reason || "");
      const ended = /^exited \d/.test(reason) || reason === "restart" || /without starting/.test(reason) ? "failed" : reason === "stopped" ? "stopped" : "idle";
      return await serial(chat, async () => {
        const rec = await findChat(chat);
        if (!rec) return null;
        await syncNameFromTranscript(p.thread);
        return refresh((await findChat(chat)) || rec, ended);
      });
    } catch (e) { log(`chat record: could not close the record for ${p.thread}: ${/** @type {Error} */ (e).message}`); return null; }
  }

  /** A chat's folder name: its id, which never changes (so a rename never touches Drive). Under its project's folder there are two: what the person dropped in (`chat`) and what a model made (`made`). */
  const KINDS = ["chat", "made"];
  /** Move a chat's two folders under another project's folder, as the PERSON who moved it: the gateway checks every file of both before either moves. A missing folder moves nothing. @param {any} by */
  async function moveChatFolders(by, /** @type {string} */ fromRoot, /** @type {string} */ name, /** @type {string} */ toRoot) {
    if (!kernel.drive || typeof kernel.drive.moveFolders !== "function" || fromRoot === toRoot) return;
    if (!underProjects(fromRoot) || !underProjects(toRoot)) return;
    await kernel.drive.moveFolders(by, KINDS.map(k => [`${fromRoot}/${k}/${name}`, `${toRoot}/${k}/${name}`]));
  }

  /** The Project a reference names: a short name, or a record address. @param {string} ref */
  async function projectOf(ref) {
    const r = String(ref || "");
    if (r.startsWith("vyre://")) { const [, , , type, id] = r.split("/"); return type === PROJECT ? kernel.records.get(chain(), PROJECT, id) : null; }
    return find(PROJECT, "slug", r);
  }

  /** "Move to project": the chat's record is linked to the other Project and carries its Drive folders; its id, times and kernel membership stay exactly as they were. */
  async function moveChat(chat, projectRef, by) {
    if (!by) throw Object.assign(new Error("a chat is moved by a person"), { code: "not_allowed" });
    const rec = await findChat(chat);
    if (!rec) throw Object.assign(new Error("no record of that chat"), { code: "not_found" });
    const proj = await projectOf(projectRef);
    if (!proj) throw Object.assign(new Error("no such project"), { code: "not_found" });
    if (rec.data.project && rec.data.project.urn === proj.urn) return rec;
    // the files first, as the person who moves it: a refused file aborts everything and nothing has changed
    if (rec.data.drive && rec.data.drive !== rootOf(proj)) await moveChatFolders(by, rec.data.drive, chat, rootOf(proj));
    const moved = await kernel.records.update(by, CHAT, rec.id, { project: { urn: proj.urn }, drive: rootOf(proj), location: locationOf(proj, chat) }, rec.version);
    // the old folder list still counts each run as picked into the project it was in
    const oldSlug = rec.data.project && rec.data.project.urn ? (await projectOf(rec.data.project.urn).catch(() => null)) : null;
    const runs = ((await tool("threads.of-chat", { chat })) || {}).runs || [];
    for (const r of runs) { await tool("projects.remove-threads", { project: oldSlug && oldSlug.data.slug, threads: [r.thread] }); await tool("projects.add-threads", { project: proj.data.slug, threads: [r.thread] }); }
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

  /** A chat's name changed somewhere: the record's title and every run's thread name agree. @param {any} rec the chat record @param {string} title @param {"record" | "thread"} from @param {string} [except] the run the change came from */
  async function renameChat(rec, title, from, by = chain(), except) {
    const t = String(title || "").trim().slice(0, 120);
    if (!t) return rec;
    let cur = rec;
    if (cur.data.title !== t) cur = await kernel.records.update(by, CHAT, cur.id, { title: t }, cur.version);
    const runs = ((await tool("threads.of-chat", { chat: cur.data.chat })) || {}).runs || [];
    for (const r of runs) if (r.thread !== except && r.name !== t) await tool("threads.rename", { thread: r.thread, name: t });
    return cur;
  }

  /** The last name the transcript showed for each run, so only a CHANGE in it counts as a rename (a stale transcript name never overwrites a title set in Records). @type {Map<string, string>} */
  const seenName = new Map();
  /** The chat a run belongs to. @param {string} thread */
  async function chatOfThread(thread) { const r = await tool("threads.chat-of", { thread }); return r && typeof r.chat === "string" ? r.chat : null; }
  /**
   * A /rename inside Claude Code lands in the transcript, which Recall indexes as the run's name. At each turn's end (and at the run's end) a name that differs from the one last seen is a rename made
   * there, and the chat's title follows. The first look only records the name.
   * @param {string} thread
   */
  async function syncNameFromTranscript(thread) {
    try {
      const chat = await chatOfThread(thread);
      const rec = chat ? await findChat(chat) : null;
      if (!rec) return null;
      const r = await tool("recall.sessions", { ids: [thread], limit: 1, machines: "local" });
      const row = Array.isArray(r) ? r[0] : null;
      const name = row && typeof row.name === "string" ? row.name.trim() : "";
      if (!name) return null;
      const before = seenName.get(thread);
      seenName.set(thread, name);
      if (before === undefined) return name !== rec.data.title && (!rec.data.title || rec.data.title === UNTITLED) ? renameChat(rec, name, "thread", chain(), thread) : null;
      return before !== name ? renameChat(rec, name, "thread", chain(), thread) : null;
    } catch (e) { log(`chat record: could not read the transcript's name for ${thread}: ${/** @type {Error} */ (e).message}`); return null; }
  }
  const onTurn = async (/** @type {any} */ p) => (p && typeof p.session === "string" ? syncNameFromTranscript(p.session) : null);

  /** Events that carry a name change from the other sides: the old project list's `project.changed` and the thread's `thread.renamed`. */
  async function onProjectChanged(p) {
    if (!p || typeof p.project !== "string") return null;
    try {
      const rec = await find(PROJECT, "slug", p.project);
      if (!rec) return null;
      // archived or brought back in the project list: the record's status follows
      if (typeof p.archived === "boolean") { const want = p.archived ? "archived" : "active"; if (rec.data.status !== want) return await kernel.records.update(chain(), PROJECT, rec.id, { status: want, archived_at: p.archived ? iso(now()) : null }, rec.version); return rec; }
      return typeof p.name === "string" ? await renameProject(rec, p.name, "list") : null;
    } catch (e) { log(`project hub: rename of ${p.project} did not reach Records: ${/** @type {Error} */ (e).message}`); return null; }
  }
  async function onThreadRenamed(p) {
    if (!p || typeof p.thread !== "string" || typeof p.name !== "string") return null;
    try { const chat = typeof p.chat === "string" ? p.chat : await chatOfThread(p.thread); const rec = chat ? await findChat(chat) : null; return rec ? await renameChat(rec, p.name, "thread", chain(), p.thread) : null; } catch (e) { log(`chat record: rename of ${p.thread} did not reach Records: ${/** @type {Error} */ (e).message}`); return null; }
  }
  /**
   * A record changed in Records itself. A person's edit of a system field is put back and nothing else happens. A name change is only a title: anyone allowed to update the record may rename, and it reaches the project
   * list and the thread for them. Nothing here touches Drive: folders are named by id, so a rename moves nothing.
   * @param {any} ev a kernel event ({ type, subject, actor, data: { changed, before, after } })
   */
  async function onRecordChanged(ev) {
    try {
      const m = /^vyre:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(String(ev && ev.subject));
      if (!m || (m[1] !== PROJECT && m[1] !== CHAT)) return null;
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
      if (m[1] === CHAT && changed.includes("title")) return await renameChat(rec, rec.data.title, "record");
    } catch (e) { log(`project hub: a change in Records did not reach its other places: ${/** @type {Error} */ (e).message}`); }
    return null;
  }

  const chatRecord = (/** @type {string} */ chat) => findChat(chat);
  return Object.freeze({ createProject, ensureProject, generalProject, ensureChatRecord, onChatCreated, onChatChanged, onStarted, onChatLinked, onStopped, onStatus, moveChat, renameProject, renameChat, onProjectChanged, onThreadRenamed, onRecordChanged, onTurn, syncNameFromTranscript, freeSlug, projectOf, chatRecord, chatFolder: (/** @type {string} */ chat) => chat });
}
