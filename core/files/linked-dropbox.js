// @ts-check
// core/files/linked-dropbox.js: Dropbox as a linked source (linked-provider.js). A link's `source` is { path: "/Clients/Smith" } or { id: "id:..." } (the Files picker's { folder } is read as an id).
// Every call is made AS THE PERSON through the seam `client.request(person, { path, args, body, raw })`, which files/dropbox-seam.js binds to that person's own Vault token. Nothing here holds a
// token, and this file never reaches the network.
//
// Dropbox keeps paths (case-insensitive) and ids; a listing is ONE recursive list_folder, with paths made relative to the linked folder. The sync token is a list_folder cursor taken BEFORE the walk
// (list_folder/get_latest_cursor), so nothing between the walk and the next sync is missed. A deleted entry in Dropbox's feed carries a path and no id, and a folder change moves everything under it,
// so either one answers a full listing (like Drive's folder change). A file's `rev` is Dropbox's own rev; an edit whose baseRev is behind it answers `conflict` and writes nothing, and the upload itself
// is mode update with that rev, so a write that races another is caught too (Dropbox would save a "conflicted copy" beside the file; that is detected and answered as a conflict).
//
// DELETE NEVER DELETES. files/delete_v2 cannot be undone, so delete moves the file into "Vyre Trash" inside the linked folder (move_v2, renamed on a clash), where it can be moved back. The
// alternative, refusing to delete at all, leaves the Delete button dead and sends people to Dropbox to tidy up; a recoverable move is the safer of the two that still works. The trash folder is hidden
// from the listing, so a trashed file leaves Linked at once.
const TRASH = "Vyre Trash";
const ID = /^id:[A-Za-z0-9_.-]{1,128}$/;
const MAX_PATH = 1024;
const MAX_WRITE = 25 * 1024 * 1024;
const MIME = /** @type {Record<string, string>} */ ({ txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", xml: "application/xml", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip" });
const FOLDER = "inode/directory";

const fail = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
/** A Dropbox refusal in Vyre's words. @param {any} e @param {string} [what] */
function mapError(e, what = "that") {
  if (e && typeof e.code === "string" && !e.status) return e;
  const s = Number(e && e.status), msg = String((e && e.message) || "");
  if (s === 401) return fail("your Dropbox token no longer works; add a new one in the Vault", "denied");
  if (s === 403) return fail(`your Dropbox account is not allowed to do that to ${what}`, "denied");
  if (s === 409) {
    if (/not_found/.test(msg)) return fail(`${what} is not in Dropbox, or your account cannot see it`, "not_found");
    if (/conflict|too_many_write_operations/.test(msg)) return fail(`${what} changed in Dropbox since you opened it`, "conflict");
    if (/unsupported|not_file|restricted_content|not_folder/.test(msg)) return fail(`Dropbox cannot open ${what} as a file`, "unsupported");
    if (/insufficient_space|disallowed_name|malformed_path|cant_/.test(msg)) return fail(`Dropbox refused that: ${msg.split("/")[0].replace(/_/g, " ")}`, "bad_input");
    return fail("Dropbox refused that", "unavailable");
  }
  if (s === 429 || s >= 500) return fail("Dropbox is not answering right now; try again in a moment", "unavailable");
  if (s === 400) return fail("Dropbox did not understand that request", "bad_input");
  return fail(String(msg || "Dropbox refused that").slice(0, 200), "unavailable");
}

/** @param {string} path @returns {string[]} */
function segments(path) {
  const p = String(path ?? "");
  if (!p || p.length > MAX_PATH || p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f]/.test(p)) throw fail("that is not a path inside the linked folder", "bad_input");
  const s = p.split("/");
  if (s.some(x => x === "" || x === "." || x === ".." || x.toLowerCase() === TRASH.toLowerCase())) throw fail("that is not a path inside the linked folder", "bad_input");
  return s;
}
/** The folder path a source names, normalised: leading slash, no trailing one, not the whole Dropbox. @param {string} p */
function folderPath(p) {
  const s = String(p ?? "").trim().replace(/\/+$/, "");
  if (!s || s.length > MAX_PATH || !s.startsWith("/") || s.includes("\\") || /[\u0000-\u001f]/.test(s) || s.split("/").some(x => x === "." || x === "..")) throw fail("link a folder inside your Dropbox, not the whole of it", "bad_input");
  return s;
}
const extOf = (/** @type {string} */ name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name); return m ? m[1].toLowerCase() : ""; };

/** @param {{ client: { request: (person: string, req: any) => Promise<any> } }} d */
export function dropboxProvider({ client }) {
  const call = async (/** @type {string} */ person, /** @type {any} */ req, /** @type {string} */ what) => { try { return await client.request(person, req); } catch (e) { throw mapError(e, what); } };
  const rpc = (/** @type {string} */ person, /** @type {string} */ path, /** @type {any} */ args, /** @type {string} */ what) => call(person, { path: `/2/files/${path}`, args }, what);

  /** The linked folder as Dropbox spells it now (an id is looked up each time, so a renamed folder still resolves). @param {any} link @param {string} person */
  async function rootOf(link, person) {
    const src = (link && link.source) || {};
    if (typeof src.path === "string") { const path = folderPath(src.path); return { path, lower: path.toLowerCase() }; }
    const id = typeof src.id === "string" ? src.id : typeof src.folder === "string" ? src.folder : "";
    if (!ID.test(id)) throw fail("this link has no Dropbox folder", "bad_input");
    let m;
    try { m = await rpc(person, "get_metadata", { path: id }, "the folder"); } catch (e) { if (/** @type {any} */ (e).code === "not_found") throw fail("this folder is not available to your Dropbox account", "denied"); throw e; }
    if (m[".tag"] !== "folder") throw fail("that is a file, not a folder", "bad_input");
    const path = folderPath(m.path_display);
    return { path, lower: path.toLowerCase() };
  }
  /** `p` relative to the root, or null when it is not inside it. @param {any} root @param {any} f */
  const relOf = (root, f) => {
    const low = String(f.path_lower || "");
    if (!low.startsWith(root.lower + "/")) return null;
    return String(f.path_display || "").slice(root.path.length + 1);
  };
  const inTrash = (/** @type {string} */ rel) => rel.toLowerCase() === TRASH.toLowerCase() || rel.toLowerCase().startsWith(TRASH.toLowerCase() + "/");
  /** @param {any} f @param {string} rel */
  function entryOf(f, rel) {
    const folder = f[".tag"] === "folder";
    return { id: String(f.id), path: rel, name: String(f.name), mime: folder ? FOLDER : MIME[extOf(String(f.name))] || "application/octet-stream", size: Number(f.size || 0), ...(folder ? { dir: true } : {}), modified: Date.parse(f.server_modified) || 0, rev: String(f.rev || "0") };
  }
  /** A file or folder by id, which must sit inside the linked folder and outside the trash. @param {string} person @param {any} root @param {any} entry */
  async function inside(person, root, entry) {
    const id = String(entry && entry.id);
    if (!ID.test(id)) throw fail("that is not a Dropbox file", "bad_input");
    const m = await rpc(person, "get_metadata", { path: id }, "that file");
    const rel = relOf(root, m);
    if (rel === null) throw fail("that file is not in the linked folder", "not_found");
    return { meta: m, rel, id };
  }
  /** Make each folder along `abs` (a Dropbox path) when it is not there. @param {string} person @param {string} abs */
  async function ensureDirs(person, abs) {
    try { await rpc(person, "create_folder_v2", { path: abs, autorename: false }, "the folder"); }
    catch (e) { if (/** @type {any} */ (e).code !== "conflict") throw e; }
  }

  async function listAll(/** @type {string} */ person, /** @type {any} */ args, /** @type {string} */ what) {
    /** @type {any[]} */ const out = [];
    let r = await rpc(person, "list_folder", args, what);
    for (;;) {
      out.push(...(r.entries || []));
      if (!r.has_more) return out;
      r = await rpc(person, "list_folder/continue", { cursor: r.cursor }, what);
    }
  }

  async function walk(/** @type {string} */ person, /** @type {any} */ root) {
    const same = { path: root.path, recursive: true, include_deleted: false, include_non_downloadable_files: false };
    const start = String((await rpc(person, "list_folder/get_latest_cursor", same, "the folder")).cursor);
    let found;
    try { found = await listAll(person, { ...same, limit: 2000 }, "the folder"); } catch (e) { if (/** @type {any} */ (e).code === "not_found") throw fail("this folder is not available to your Dropbox account", "denied"); throw e; }
    /** @type {any[]} */ const entries = [];
    for (const f of found) {
      if (f[".tag"] === "deleted") continue;
      const rel = relOf(root, f);
      if (rel === null || inTrash(rel)) continue;
      entries.push(entryOf(f, rel));
    }
    return { entries, next: start, full: true };
  }

  async function changes(/** @type {string} */ person, /** @type {any} */ root, /** @type {string} */ token) {
    /** @type {any[]} */ const seen = [];
    let cursor = token;
    try {
      for (;;) {
        const r = await client.request(person, { path: "/2/files/list_folder/continue", args: { cursor } });
        seen.push(...(r.entries || [])); cursor = String(r.cursor);
        if (!r.has_more) break;
      }
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (Number(err && err.status) === 409 && /^reset/.test(String(err.message))) return walk(person, root);
      throw mapError(e, "the folder");
    }
    /** @type {any[]} */ const entries = [];
    for (const f of seen) {
      if (f[".tag"] === "deleted" || f[".tag"] === "folder") return walk(person, root);
      const rel = relOf(root, f);
      if (rel === null) continue;
      if (inTrash(rel)) { entries.push({ id: String(f.id), path: "", name: "", rev: "0", deleted: true }); continue; }
      entries.push(entryOf(f, rel));
    }
    return { entries, next: cursor, full: false };
  }

  return {
    id: "dropbox",
    label: "Dropbox",
    /** The folders directly inside `parent` (the top of your Dropbox when none), as the person, for choosing a folder to link. @param {string} person @param {{ parent?: string }} [o] */
    async pick(person, o = {}) {
      const parent = o.parent === undefined || o.parent === "" || o.parent === "root" ? "" : String(o.parent);
      if (parent !== "" && !ID.test(parent)) throw fail("that is not a Dropbox folder", "bad_input");
      const kids = await listAll(person, { path: parent, recursive: false, include_deleted: false, limit: 2000 }, "that folder");
      return { parent: parent || "root", folders: kids.filter(f => f[".tag"] === "folder" && f.name !== TRASH).map(f => ({ id: String(f.id), name: String(f.name) })).sort((a, b) => a.name.localeCompare(b.name)) };
    },
    /** @param {any} link @param {string} person @param {{ token?: string }} [o] */
    async list(link, person, o = {}) {
      const root = await rootOf(link, person);
      return o.token != null && o.token !== "" ? changes(person, root, String(o.token)) : walk(person, root);
    },
    /** @param {any} link @param {string} person @param {{ id: string }} entry */
    async read(link, person, entry) {
      const root = await rootOf(link, person);
      const id = String(entry && entry.id);
      if (!ID.test(id)) throw fail("that is not a Dropbox file", "bad_input");
      const r = await call(person, { path: "/2/files/download", args: { path: id }, raw: true }, "that file");
      const res = r.result || {};
      if (relOf(root, res) === null) throw fail("that file is not in the linked folder", "not_found");
      return { bytes: r.bytes, mime: MIME[extOf(String(res.name || ""))] || "application/octet-stream", rev: String(res.rev ?? "0") };
    },
    /** @param {any} link @param {string} person @param {string} path @param {Uint8Array} bytes @param {{ baseRev?: string }} [o] */
    async write(link, person, path, bytes, o = {}) {
      const root = await rootOf(link, person), segs = segments(path);
      if (bytes.length > MAX_WRITE) throw fail("That file is over 25 MB, which is as much as Vyre sends to Dropbox", "too_large");
      const abs = `${root.path}/${segs.join("/")}`;
      /** @type {any} */ let have = null;
      try { have = await rpc(person, "get_metadata", { path: abs }, "that file"); } catch (e) { if (/** @type {any} */ (e).code !== "not_found") throw e; }
      if (have && have[".tag"] === "folder") throw fail("that is a folder, not a file", "bad_input");
      let mode;
      if (have) {
        if (o.baseRev !== undefined && String(have.rev) !== String(o.baseRev)) throw fail("the file changed in Dropbox since you opened it", "conflict");
        mode = o.baseRev !== undefined ? { ".tag": "update", update: String(have.rev) } : { ".tag": "overwrite" };
      } else {
        if (o.baseRev !== undefined) throw fail("the file is gone from Dropbox since you opened it", "conflict");
        mode = { ".tag": "add" };
      }
      const r = await call(person, { path: "/2/files/upload", args: { path: abs, mode, autorename: false, mute: true, strict_conflict: true }, body: bytes }, "that file");
      // Dropbox answers a lost race by saving "(conflicted copy)" beside the file: the path it answers is not the path asked for.
      if (String(r.path_lower || "").toLowerCase() !== abs.toLowerCase()) throw fail("the file changed in Dropbox since you opened it; Dropbox kept your version as a separate copy beside it", "conflict");
      return { id: String(r.id), rev: String(r.rev) };
    },
    /** @param {any} link @param {string} person @param {{ id: string }} entry @param {string} toPath */
    async rename(link, person, entry, toPath) {
      const root = await rootOf(link, person), segs = segments(toPath);
      const { id, rel } = await inside(person, root, entry);
      if (inTrash(rel)) throw fail("a file in Vyre Trash is moved back in Dropbox", "bad_input");
      let dir = root.path;
      for (const seg of segs.slice(0, -1)) { dir = `${dir}/${seg}`; await ensureDirs(person, dir); }
      const r = await rpc(person, "move_v2", { from_path: id, to_path: `${root.path}/${segs.join("/")}`, autorename: false, allow_ownership_transfer: false }, "that file");
      const m = r.metadata || {};
      return { id: String(m.id || id), rev: String(m.rev || "0") };
    },
    /** Moves to Vyre Trash inside the linked folder; never files/delete_v2. @param {any} link @param {string} person @param {{ id: string }} entry */
    async delete(link, person, entry) {
      const root = await rootOf(link, person);
      const { id, meta, rel } = await inside(person, root, entry);
      if (inTrash(rel)) return { deleted: true };
      await ensureDirs(person, `${root.path}/${TRASH}`);
      await rpc(person, "move_v2", { from_path: id, to_path: `${root.path}/${TRASH}/${String(meta.name)}`, autorename: true, allow_ownership_transfer: false }, "that file");
      return { deleted: true };
    },
    /** @param {any} link @param {string} person @param {{ id: string }} entry */
    async versions(link, person, entry) {
      const root = await rootOf(link, person);
      const { id, meta } = await inside(person, root, entry);
      if (meta[".tag"] === "folder") return [];
      const r = await rpc(person, "list_revisions", { path: id, mode: { ".tag": "id" }, limit: 20 }, "that file");
      return (r.entries || []).map((/** @type {any} */ v) => ({ rev: String(v.rev), modified: Date.parse(v.server_modified) || 0 }));
    },
  };
}
