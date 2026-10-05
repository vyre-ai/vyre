// @ts-check
// Every file of a project lands in the project's Drive folder (the user, 6 Oct 2026). The Project hub (core/work/hub.js) makes the folder, Projects/<slug>/; this saves into it and keeps one
// record for each file, linked from its session and its Project:
//
//   Projects/<slug>/chat/<session folder>/<name>   what the person dropped into a chat (a pasted image, an attachment)
//   Projects/<slug>/made/<session folder>/<name>   what a model made (an image, a document, a page, a code output)
//
// <session folder> is the session's id (the Project hub names folders by id, never by title: hub.sessionFolder), and the project root is the Project record's own `drive_path`. A rename never moves anything;
// the one move is "Move to project", which the Drive reports as `file.moved` and `onMoved` follows.
// The bytes go through the kernel's Drive under the work module's own service chain (the Drive's grants and log apply); the record is a `project-file` (records/core-types.js). A file is saved once:
// its key is the thread, the kind and the content hash (or the artifact it is a version of), so a second look at the same bytes changes nothing, and a new version of an artifact is a new Drive version of
// the same path. Nothing here ever breaks a turn: a failure is logged and answered as `null`.

import crypto from "node:crypto";

const FILE = "project-file", SUMMARY = "session-summary", PROJECT = "project";
export const MAX_FILE = 100 * 1024 * 1024;
export const KINDS = ["chat", "made"];

/** A name safe as one Drive path segment: no slashes, controls or leading dots, at most 120 characters, the extension kept. @param {string} raw @param {string} [fallback] */
export function safeName(raw, fallback = "file") {
  let n = String(raw ?? "").split(/[\\/]/).pop() || "";
  n = n.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").replace(/\s+/g, " ").trim();
  if (n.length > 120) { const dot = n.lastIndexOf("."), ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : ""; n = n.slice(0, 120 - ext.length) + ext; }
  return n || fallback;
}

/**
 * @param {{ kernel: any, hub: { sessionRecord: Function, sessionFolder: Function, projectOf: Function, onStarted: Function, ensureProject: Function }, call?: (tool: string, input: any) => Promise<any>, log?: (m: string) => void }} o
 */
export function createFiles({ kernel, hub, call, log: log0 = () => {} }) {
  const log = (/** @type {string} */ m) => { if (process.env.DEBUGFILES) console.log("FILESLOG " + m); log0(m); };
  const chain = () => kernel.serviceChain("work");
  const find = async (/** @type {string} */ type, /** @type {string} */ field, /** @type {string} */ value) => (await kernel.records.query(chain(), type, { filter: { field, op: "eq", value }, page: { limit: 1 } })).rows[0] || null;
  const idOf = (/** @type {string} */ urn) => String(urn).split("/").pop() || "";
  const dec = new TextDecoder();

  /** The session record and Project record a thread belongs to; the summary is made from what threads knows when the hub has not seen the thread yet. @param {string} thread */
  async function contextOf(thread) {
    let summary = await hub.sessionRecord(thread);
    if (!summary && call) {
      try { const r = await call("threads.get", { thread, limit: 1 }); const t = r && (r.data || r); const th = t && (t.thread || t);
        if (th && th.id) summary = await hub.onStarted({ thread, name: th.name, project: th.project, cwd: th.cwd, provider: th.provider, model: th.model, agent: th.agent }); } catch { /* unknown thread */ }
    }
    if (!summary) return null;
    /** @type {any} */ let project = null;
    if (summary.data.project && summary.data.project.urn) project = await hub.projectOf(summary.data.project.urn);
    if (!project && call) {
      try { const r = await call("threads.get", { thread, limit: 1 }); const th = r && ((r.data && (r.data.thread || r.data)) || r); const slug = th && th.project;
        if (slug) { project = await hub.ensureProject(String(slug)); if (project) summary = await kernel.records.update(chain(), SUMMARY, summary.id, { project: { urn: project.urn } }, summary.version); } } catch { /* no project */ }
    }
    return project ? { summary, project } : null;
  }

  /**
   * Save one file of a session into its project's folder.
   * @param {{ thread: string, kind: "chat" | "made", name: string, bytes: Uint8Array, mime?: string, source?: string, artifact?: string, key?: string }} f
   * @returns {Promise<{ path: string, record: any, created: boolean, version: number } | null>} null when the thread has no project or the file could not be kept
   */
  async function saveFile(f) {
    try {
      if (!KINDS.includes(f.kind)) throw new Error("a file is chat or made");
      if (!(f.bytes instanceof Uint8Array) || f.bytes.length === 0 || f.bytes.length > MAX_FILE) throw new Error("a file is bytes, up to 100 MB");
      if (!kernel.drive || typeof kernel.drive.put !== "function") return null;
      const ctx = await contextOf(String(f.thread));
      if (!ctx) return null;
      const sha = crypto.createHash("sha256").update(f.bytes).digest("hex");
      const key = f.key || `${f.thread}:${f.kind}:${sha}`;
      const have = await find(FILE, "key", key);
      const folder = `${ctx.project.data.drive_path || `Projects/${ctx.project.data.slug}`}/${f.kind}/${hub.sessionFolder(ctx.summary)}`;
      if (have) {
        if (have.data.sha256 === sha) return { path: have.data.path, record: have, created: false, version: 0 };
        // a new version of the same thing (an artifact edited): the same path, a new Drive version, the record follows
        const head = (await kernel.drive.history(chain(), have.data.path)).at(-1);
        const put = await kernel.drive.put(chain(), have.data.path, f.bytes, { base: head ? head.ver : null });
        const rec = await kernel.records.update(chain(), FILE, have.id, { sha256: sha, size: f.bytes.length, ...(f.mime ? { mime: f.mime } : {}) }, have.version);
        return { path: have.data.path, record: rec, created: false, version: put.version };
      }
      const name = await freeName(folder, safeName(f.name));
      const path = `${folder}/${name}`;
      const put = await kernel.drive.put(chain(), path, f.bytes, { base: null });
      const rec = await kernel.records.create(chain(), FILE, {
        name, path, kind: f.kind, size: f.bytes.length, sha256: sha, key, thread: String(f.thread), ...(f.mime ? { mime: String(f.mime).slice(0, 100) } : {}), ...(f.source ? { source: String(f.source).slice(0, 200) } : {}),
        ...(f.artifact ? { artifact: String(f.artifact) } : {}), project: { urn: ctx.project.urn }, session: { urn: ctx.summary.urn },
      });
      return { path, record: rec, created: true, version: put.version };
    } catch (e) { log(`project files: could not save ${String(f && f.name).slice(0, 60)} for ${String(f && f.thread).slice(0, 8)}: ${/** @type {Error} */ (e).message}`); return null; }
  }

  /** A name not yet used in a folder: "a.png", then "a (2).png". @param {string} folder @param {string} name */
  async function freeName(folder, name) {
    const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 1; n < 1000; n++) {
      const cand = n === 1 ? name : `${stem} (${n})${ext}`;
      const taken = await find(FILE, "path", `${folder}/${cand}`);
      if (!taken) return cand;
    }
    throw new Error("too many files of one name in a folder");
  }

  /**
   * The Drive moved a folder (a session filed under another Project): rewrite the prefix on the records of the files under it, and point each at its session's Project now.
   * @param {{ from: string, to: string }} m
   */
  async function onMoved(m) {
    if (!m || typeof m.from !== "string" || typeof m.to !== "string") return { updated: 0 };
    let updated = 0, after = null;
    // the Project whose folder the files are in now (the session's own link is moved after the Drive, so the path is the truth)
    const projects = (await kernel.records.query(chain(), PROJECT, { page: { limit: 500 } })).rows;
    const now = projects.find((/** @type {any} */ p) => p.data.drive_path && (m.to === p.data.drive_path || m.to.startsWith(p.data.drive_path + "/"))) || null;
    for (let page = 0; page < 50; page++) {
      const r = await kernel.records.query(chain(), FILE, { page: { limit: 200, ...(after ? { cursor: after } : {}) } });
      for (const row of r.rows) {
        const at = String(row.data.path || "");
        if (at !== m.from && !at.startsWith(m.from + "/")) continue;
        const to = m.to + at.slice(m.from.length);
        try { await kernel.records.update(chain(), FILE, row.id, { path: to, ...(now ? { project: { urn: now.urn } } : {}) }, row.version); updated++; }
        catch (e) { log(`project files: could not follow ${at}: ${/** @type {Error} */ (e).message}`); }
      }
      after = r.next_cursor;
      if (!after) break;
    }
    return { updated };
  }

  return Object.freeze({ saveFile, onMoved, contextOf });
}
