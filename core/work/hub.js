// @ts-check
// The Project hub (team/0.3/DESIGN-project-hub.md): a Project is one record, and its sessions, Drive folder and memory room hang off it. This is the writing side, in the work module (it already holds
// a kernel handle and writes records under its own service chain):
//
//   createProject(chain, { name, repo?, client? })   the record, with its slug, its Drive folder (a marker file, since Drive has only path prefixes) and its memory scope
//   ensureProject(slug, name?)                       the Project record for a slug the old folder projects still use, made on first sight
//   onStarted(payload) / onStopped(payload)          the switchboard's thread.started and thread.stopped, as a session summary record linked to the Project
//
// A summary never holds transcript text: the transcript and checkpoints stay sealed in the kernel, and `transcript` is the address they are kept under. What a session summary SAYS comes from an
// injected `summarize(threadId)` (the daemon supplies one that goes through the model door, so sealed values are placeholders and the AI budget counts it); without one it is plain facts: the turns and the
// model. Never empty, never invented.

import { slugify, SLUG_RE } from "../../lib/project-id.js";

const PROJECT = "project", SUMMARY = "session-summary";

/**
 * @param {{ kernel: any, call?: (tool: string, input: any) => Promise<any>, summarize?: (thread: string) => Promise<string | null>, now?: () => number, log?: (m: string) => void }} o
 */
export function createHub({ kernel, call, summarize, now = Date.now, log = () => {} }) {
  const chain = () => kernel.serviceChain("work");
  const iso = (/** @type {number} */ t) => new Date(t).toISOString();
  const urnOf = (/** @type {string} */ type, /** @type {string} */ id) => `vyre://${kernel.space}/${type}/${id}`;
  const find = async (/** @type {string} */ type, /** @type {string} */ field, /** @type {string} */ value) => (await kernel.records.query(chain(), type, { filter: { field, op: "eq", value }, page: { limit: 1 } })).rows[0] || null;

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
    const rec = await kernel.records.create(caller || chain(), PROJECT, { name: nm, slug: s, status: "active", drive_path: `Projects/${s}`, memory_scope: `project:${s}`, ...(repo ? { repo: String(repo).slice(0, 300) } : {}), ...(client ? { client: { urn: String(client) } } : {}) });
    await folderMarker(rec);
    return rec;
  }

  /** Drive has path prefixes, not folders: a folder exists when a file does. The marker is the record's own address, so the folder is there and says what it is for. @param {any} rec */
  async function folderMarker(rec) {
    if (!kernel.drive || typeof kernel.drive.put !== "function") return;
    try { await kernel.drive.put(chain(), `${rec.data.drive_path}/.project`, new TextEncoder().encode(`${rec.urn}\n`)); }
    catch (e) { log(`project hub: no Drive folder marker for ${rec.data.slug} (${/** @type {Error} */ (e).message})`); }
  }

  /** The Project for a slug an older part of the system still names; made from the folder project's name on first sight. @param {string} slug @param {string} [name] */
  async function ensureProject(slug, name) {
    if (!slug || !SLUG_RE.test(slug)) return null;
    const have = await find(PROJECT, "slug", slug);
    if (have) return have;
    let nm = name;
    if (!nm && call) { try { const r = await call("projects.list", {}); const list = (r && (r.data || r)).projects || (r && r.data) || []; const hit = Array.isArray(list) ? list.find((/** @type {any} */ p) => p.slug === slug) : null; if (hit) nm = hit.name; } catch { /* the slug is name enough */ } }
    return createProject(chain(), { name: nm || slug, slug });
  }

  /** @param {any} p the thread.started payload ({ thread, name, cwd, project, agent, provider, model, auth, purpose, ... }) */
  async function onStarted(p) {
    if (!p || typeof p.thread !== "string") return null;
    try {
      const have = await find(SUMMARY, "thread", p.thread);
      if (have) {
        // a resumed session is the same record, working again
        return kernel.records.update(chain(), SUMMARY, have.id, { status: "working", ended: null }, have.version);
      }
      const proj = p.project ? await ensureProject(String(p.project)).catch(() => null) : null;
      let acct = null;
      if (call) { try { const r = await call("threads.get", { id: p.thread }); const t = r && (r.data || r); acct = t && t.account || null; } catch { /* unknown */ } }
      return await kernel.records.create(chain(), SUMMARY, {
        title: String(p.name || (p.agent ? `${p.agent} session` : "Session")).slice(0, 120), ...(proj ? { project: { urn: proj.urn } } : {}),
        people: String(kernel.owner || ""), ...(p.agent ? { agents: String(p.agent) } : {}), ...(p.provider ? { provider: String(p.provider) } : {}), ...(p.model ? { model: String(p.model) } : {}), ...(acct ? { account: String(acct) } : {}),
        started: iso(now()), status: "working", thread: p.thread, transcript: urnOf("session", p.thread),
      });
    } catch (e) { log(`project hub: could not write the session summary for ${p.thread}: ${/** @type {Error} */ (e).message}`); return null; }
  }

  /** @param {any} p the thread.stopped payload ({ thread, code, reason }) */
  async function onStopped(p) {
    if (!p || typeof p.thread !== "string") return null;
    try {
      const have = await find(SUMMARY, "thread", p.thread);
      if (!have) return null;
      let t = null;
      if (call) { try { const r = await call("threads.get", { id: p.thread }); t = r && (r.data || r); } catch { /* the facts we have */ } }
      const reason = String(p.reason || "");
      const status = /^exited \d/.test(reason) || reason === "restart" || /without starting/.test(reason) ? "failed" : reason === "stopped" ? "stopped" : "done";
      let said = null;
      if (summarize) { try { said = await summarize(p.thread); } catch { said = null; } }
      const turns = t && Number.isFinite(t.turns) ? t.turns : null;
      const facts = `${turns === null ? "A session" : `${turns} turn${turns === 1 ? "" : "s"}`}${have.data.model ? ` on ${have.data.model}` : ""}${reason ? `, ended: ${reason.slice(0, 80)}` : ""}.`;
      return await kernel.records.update(chain(), SUMMARY, have.id, { status, ended: iso(now()), summary: String(said || facts).slice(0, 1500), ...(t && t.model ? { model: String(t.model) } : {}) }, have.version);
    } catch (e) { log(`project hub: could not close the session summary for ${p.thread}: ${/** @type {Error} */ (e).message}`); return null; }
  }

  return Object.freeze({ createProject, ensureProject, onStarted, onStopped, freeSlug });
}
