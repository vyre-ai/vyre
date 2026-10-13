// @ts-check
// A team member's project files (0.3.3): list, read and upload in the FILES AREA of one project, from the app, on the team's server. The operations behind the member door's `files` rows (core/work/member-tools.js,
// served by work.serve / work.serve-write). The door has already taken the chain's one person hop and refused a non-member; these run under HER chain, so the gateway's own project-files rule decides who may
// (the project's owner and team, measured in core/work/member-projects.test.js), not this code:
//   - the folder is BUILT here from the project record (`Projects/<record id>/files/`), never taken from her input; the project is named by its record id or its short name;
//   - a file is named by a plain name: no separator, no `..`, no leading dot; there are no sub-folders, so nothing outside `files/` (the `.project` marker included) is reachable;
//   - a file is at most MAX_BYTES up (MAX_READ_BYTES down: what the door carries) and a project holds at most MAX_FILES, refused in words;
//   - no versions, restore, links, shares, delete or move: a member on a team gets those later (team/BACKLOG.md rc.3).

import { KernelError } from "../../kernel/core/errors.js";
import { projectFiles, whereIs } from "../../lib/files/layout.js";

// The door carries a request of at most 256 KB and an answer of at most 2 MB (kernel/remote/wire.js MAX_REQUEST_BYTES / MAX_RESPONSE_BYTES), and a file travels as base64 (a third larger): so what fits is 150 KB up and 1.4 MB down. A bigger file is not a member call yet (chunks: team/BACKLOG.md rc.3).
export const MAX_BYTES = 150 * 1024;
export const MAX_READ_BYTES = 1_400_000;
export const MAX_FILES = 200;
/** The keys each call takes (the door drops others; these also refuse a bad value in words). */
export const KEYS = Object.freeze({ "files-list": ["project"], "files-read": ["project", "name"], "files-upload": ["project", "name", "data"] });
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/;

/** A file name a member may use in a project's files area, or a refusal that says what a name is. @param {unknown} name */
export function fileName(name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!NAME.test(n) || n.includes("..") || n.endsWith(".")) throw new KernelError("bad_input", "A file name is letters, numbers, spaces, dots, dashes and underscores (up to 120), starting with a letter or number, with no folder in it. Rename the file and try again.");
  return n;
}

/** @param {{ kernel: () => any, maxFiles?: number }} o */
export function createMemberFiles(o) {
  const maxFiles = o.maxFiles ?? MAX_FILES;
  /** The project's files folder, from its record: she must be able to read the record. @param {any} chain @param {unknown} project */
  const folderOf = async (chain, project) => {
    const id = typeof project === "string" ? project.trim() : "";
    if (!id || id.length > 80) throw new KernelError("bad_input", "Name the project (its short name).");
    const k = o.kernel();
    /** @type {any} */ let rec = null;
    try { rec = await k.records.get(chain, "project", id); } catch { rec = null; }
    if (!rec) rec = ((await k.records.query(chain, "project", { filter: { field: "slug", op: "eq", value: id }, page: { limit: 1 } })).rows || [])[0] || null;
    if (!rec || !rec.data || typeof rec.data.drive_path !== "string" || !/^Projects\/[A-Za-z0-9_-]{1,64}$/.test(rec.data.drive_path)) throw new KernelError("not_found", "No project like that that you can open. Ask the project's owner to add you.");
    return projectFiles(/** @type {any} */ (whereIs(rec.data.drive_path)).id);
  };
  const clean = (/** @type {string} */ call, /** @type {any} */ input) => {
    const i = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    const allowed = /** @type {string[]} */ (/** @type {any} */ (KEYS)[call]);
    for (const k of Object.keys(i)) if (!allowed.includes(k)) throw new KernelError("bad_input", `${k} is not something a member names here; this takes ${allowed.join(", ")}.`);
    return i;
  };
  const names = async (/** @type {any} */ chain, /** @type {string} */ folder) => {
    const rows = await o.kernel().drive.list(chain, folder);
    return rows.map((/** @type {any} */ e) => ({ path: String(e.path ?? e.name ?? e), size: e.size ?? null, version: e.version ?? null })).filter((/** @type {any} */ e) => e.path.startsWith(`${folder}/`) && !e.path.slice(folder.length + 1).includes("/"));
  };
  return Object.freeze({
    "files-list": async (/** @type {any} */ chain, /** @type {any} */ input) => {
      const i = clean("files-list", input);
      const folder = await folderOf(chain, i.project);
      const files = (await names(chain, folder)).slice(0, MAX_FILES).map((/** @type {any} */ e) => ({ name: e.path.slice(folder.length + 1), size: e.size, version: e.version }));
      return { files };
    },
    "files-read": async (/** @type {any} */ chain, /** @type {any} */ input) => {
      const i = clean("files-read", input);
      const name = fileName(i.name);
      const folder = await folderOf(chain, i.project);
      /** @type {Uint8Array} */ let bytes;
      try { bytes = await o.kernel().drive.get(chain, `${folder}/${name}`, { maxBytes: MAX_READ_BYTES }); }
      catch (e) { if (e && /** @type {any} */ (e).code === "too_large") throw new KernelError("too_large", "That file is too big to open from the app (over 1.4 MB). Ask the owner to open it."); throw e; }
      return { name, size: bytes.length, data: Buffer.from(bytes).toString("base64") };
    },
    "files-upload": async (/** @type {any} */ chain, /** @type {any} */ input) => {
      const i = clean("files-upload", input);
      const name = fileName(i.name);
      if (typeof i.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(i.data)) throw new KernelError("bad_input", "The file's content is sent as base64 text.");
      if (i.data.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) throw new KernelError("too_large", `A file sent from the app is at most ${MAX_BYTES / 1024} KB for now. Send a smaller one, or ask the owner to add it.`);
      const bytes = new Uint8Array(Buffer.from(i.data, "base64"));
      if (bytes.length > MAX_BYTES) throw new KernelError("too_large", `A file sent from the app is at most ${MAX_BYTES / 1024} KB for now. Send a smaller one, or ask the owner to add it.`);
      const folder = await folderOf(chain, i.project);
      const have = await names(chain, folder);
      if (!have.some((/** @type {any} */ e) => e.path === `${folder}/${name}`) && have.length >= maxFiles) throw new KernelError("not_allowed", `A project holds at most ${maxFiles} files here. Remove one from the project's owner side, or ask the owner.`);
      const r = await o.kernel().drive.put(chain, `${folder}/${name}`, bytes);
      return { name, size: bytes.length, version: r && r.version != null ? r.version : null };
    },
  });
}
