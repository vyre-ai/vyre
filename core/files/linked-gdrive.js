// @ts-check
// core/files/linked-gdrive.js: Google Drive as a linked source (linked-provider.js). A link's `source` is { folder: <Drive folder id> }. Every call is made AS THE PERSON through the seam
// `client.request(person, { method, path, query, body, raw })`, which the Google module binds to that person's account (their own sign-in, or the firm key acting as them), so what a person
// sees is never more than Google lets their account see. Nothing here holds a token, and this file never reaches the network: the seam does.
//
// Drive keeps folders by id, not path, so a listing walks the tree from the linked folder and builds paths relative to it. Changes come from Drive's changes feed (the token is a changes page
// token taken BEFORE the walk, so nothing between the walk and the next sync is missed); a changed folder moves everything under it, so that case answers a full listing. A file's `rev` is
// Drive's own integer `version`, and a write whose baseRev is behind it answers `conflict` and writes nothing (Drive has no conditional upload, so a write racing another within the same
// moment is last-write-wins at Drive; the check shrinks that window to the gap between two calls). A Google Doc, Sheet or Slides file is read as text and is not written as bytes.
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const NATIVE_EXPORT = /** @type {Record<string, string>} */ ({
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
});
const FIELDS = "id,name,mimeType,parents,trashed,version,modifiedTime,size";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_DEPTH = 50;
const MAX_PATH = 1024;

const fail = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
/** A Drive refusal in Vyre's words. @param {any} e @param {string} [what] */
function mapError(e, what = "that") {
  if (e && typeof e.code === "string" && !e.status) return e;
  const s = Number(e && e.status);
  if (s === 404) return fail(`${what} is not in Drive, or your account cannot see it`, "not_found");
  if (s === 401 || s === 403) return fail(`your Google account is not allowed to do that to ${what}`, "denied");
  if (s === 409 || s === 412) return fail(`${what} changed in Drive since you opened it`, "conflict");
  if (s === 429 || s >= 500) return fail("Google Drive is not answering right now; try again in a moment", "unavailable");
  return fail(String((e && e.message) || "Google Drive refused that").slice(0, 200), "unavailable");
}
const q1 = (/** @type {string} */ s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const safeName = (/** @type {string} */ n) => String(n || "").replace(/[\\/]/g, "-") || "unnamed";

/** @param {string} path @returns {string[]} */
function segments(path) {
  const p = String(path ?? "");
  if (!p || p.length > MAX_PATH || p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f]/.test(p)) throw fail("that is not a path inside the linked folder", "bad_input");
  const s = p.split("/");
  if (s.some(x => x === "" || x === "." || x === "..")) throw fail("that is not a path inside the linked folder", "bad_input");
  return s;
}
/** @param {any} link */
function rootOf(link) {
  const id = link && link.source && link.source.folder;
  if (typeof id !== "string" || !ID.test(id)) throw fail("this link has no Drive folder id", "bad_input");
  return id;
}
/** @param {any} f @param {string} path */
function entryOf(f, path) {
  const native = Object.prototype.hasOwnProperty.call(NATIVE_EXPORT, f.mimeType);
  return { id: String(f.id), path, name: String(f.name), mime: f.mimeType === FOLDER ? FOLDER : native ? NATIVE_EXPORT[f.mimeType] : String(f.mimeType || ""), size: Number(f.size || 0), ...(f.mimeType === FOLDER ? { dir: true } : {}), modified: Date.parse(f.modifiedTime) || 0, rev: String(f.version ?? "0"), ...(native ? { indexable: true } : {}) };
}

/** @param {{ client: { request: (person: string, req: any) => Promise<any> } }} d */
export function googleDriveProvider({ client }) {
  const call = async (/** @type {string} */ person, /** @type {any} */ req, /** @type {string} */ what) => { try { return await client.request(person, req); } catch (e) { throw mapError(e, what); } };

  /** The folder's children, all pages. */
  async function children(/** @type {string} */ person, /** @type {string} */ parent, /** @type {string} */ what, /** @type {string} */ name) {
    const out = []; let pageToken;
    do {
      const r = await call(person, { path: "/drive/v3/files", query: { q: `'${q1(parent)}' in parents and trashed = false${name ? ` and name = '${q1(name)}'` : ""}`, fields: `nextPageToken,files(${FIELDS})`, pageSize: 1000, ...(pageToken ? { pageToken } : {}), supportsAllDrives: true, includeItemsFromAllDrives: true } }, what);
      out.push(...(r.files || [])); pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  async function walk(/** @type {string} */ person, /** @type {string} */ root) {
    const startToken = String((await call(person, { path: "/drive/v3/changes/startPageToken", query: { supportsAllDrives: true } }, "the folder")).startPageToken);
    /** @type {any[]} */ const entries = [];
    const queue = [{ id: root, rel: "" }];
    for (let first = true; queue.length;) {
      const { id, rel } = /** @type {any} */ (queue.shift());
      let kids;
      try { kids = await children(person, id, "the folder", ""); } catch (e) { if (first && /** @type {any} */ (e).code === "not_found") throw fail("this folder is not available to your Google account", "denied"); throw e; }
      first = false;
      const used = new Set();
      for (const f of kids) {
        if (f.mimeType === SHORTCUT) continue;
        let name = safeName(f.name);
        if (used.has(name)) name = `${name} (${String(f.id).slice(0, 6)})`;
        used.add(name);
        const path = rel ? `${rel}/${name}` : name;
        entries.push(entryOf({ ...f, name }, path));
        if (f.mimeType === FOLDER) queue.push({ id: String(f.id), rel: path });
      }
    }
    return { entries, next: startToken, full: true };
  }

  /** Where a changed file sits under the linked folder: its path, or null when it is not inside it (or the person cannot see its parents). */
  async function placeOf(/** @type {string} */ person, /** @type {string} */ root, /** @type {any} */ f, /** @type {Map<string, any>} */ cache) {
    const names = [safeName(f.name)];
    let parents = f.parents || [];
    for (let d = 0; d < MAX_DEPTH; d++) {
      const pid = parents[0];
      if (!pid) return null;
      if (pid === root) return names.reverse().join("/");
      let m = cache.get(pid);
      if (!m) { try { m = await client.request(person, { path: `/drive/v3/files/${pid}`, query: { fields: FIELDS, supportsAllDrives: true } }); } catch { return null; } cache.set(pid, m); }
      names.push(safeName(m.name)); parents = m.parents || [];
    }
    return null;
  }

  async function changes(/** @type {string} */ person, /** @type {string} */ root, /** @type {string} */ token) {
    /** @type {Map<string, any>} */ const latest = new Map();
    let pageToken = token, next = token;
    do {
      const r = await call(person, { path: "/drive/v3/changes", query: { pageToken, fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`, pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true } }, "the folder");
      for (const c of r.changes || []) latest.set(String(c.fileId), c);
      if (r.newStartPageToken) next = String(r.newStartPageToken);
      pageToken = r.nextPageToken;
    } while (pageToken);
    /** @type {any[]} */ const entries = [];
    const cache = new Map();
    for (const [id, c] of latest) {
      const f = c.file;
      if (c.removed || !f || f.trashed) { entries.push({ id, path: "", name: "", rev: "0", deleted: true }); continue; }
      const path = await placeOf(person, root, f, cache);
      if (path === null) { entries.push({ id, path: "", name: "", rev: "0", deleted: true }); continue; }
      if (f.mimeType === FOLDER) return walk(person, root);
      if (f.mimeType === SHORTCUT) continue;
      entries.push(entryOf(f, path));
    }
    return { entries, next, full: false };
  }

  /** The folder id at `segs` under the root, creating missing folders when asked; null when absent and not asked. */
  async function dirAt(/** @type {string} */ person, /** @type {string} */ root, /** @type {string[]} */ segs, /** @type {boolean} */ make) {
    let id = root;
    for (const seg of segs) {
      const hit = (await children(person, id, "the folder", seg)).find(f => f.mimeType === FOLDER);
      if (hit) { id = String(hit.id); continue; }
      if (!make) return null;
      id = String((await call(person, { method: "POST", path: "/drive/v3/files", body: { name: seg, mimeType: FOLDER, parents: [id] }, query: { fields: FIELDS, supportsAllDrives: true } }, "the folder")).id);
    }
    return id;
  }

  return {
    id: "gdrive",
    /** @param {any} link @param {string} person @param {{ token?: string }} [o] */
    async list(link, person, o = {}) {
      const root = rootOf(link);
      return o.token != null && o.token !== "" ? changes(person, root, String(o.token)) : walk(person, root);
    },
    /** @param {any} link @param {string} person @param {{ id: string }} entry */
    async read(link, person, entry) {
      rootOf(link);
      const id = String(entry && entry.id);
      if (!ID.test(id)) throw fail("that is not a Drive file", "bad_input");
      const meta = await call(person, { path: `/drive/v3/files/${id}`, query: { fields: FIELDS, supportsAllDrives: true } }, "that file");
      if (meta.mimeType === FOLDER) throw fail("a folder has no content to open", "bad_input");
      const exp = NATIVE_EXPORT[meta.mimeType];
      const r = exp
        ? await call(person, { path: `/drive/v3/files/${id}/export`, query: { mimeType: exp }, raw: true }, "that file")
        : await call(person, { path: `/drive/v3/files/${id}`, query: { alt: "media", supportsAllDrives: true }, raw: true }, "that file");
      return { bytes: r.bytes, mime: exp || meta.mimeType, rev: String(meta.version ?? "0") };
    },
    /** @param {any} link @param {string} person @param {string} path @param {Uint8Array} bytes @param {{ baseRev?: string }} [o] */
    async write(link, person, path, bytes, o = {}) {
      const root = rootOf(link), segs = segments(path), name = /** @type {string} */ (segs.pop());
      const dir = await dirAt(person, root, segs, o.baseRev === undefined);
      const existing = dir === null ? undefined : (await children(person, dir, "the folder", name)).find(f => f.mimeType !== FOLDER);
      if (existing) {
        if (NATIVE_EXPORT[existing.mimeType]) throw fail("a Google Doc, Sheet or Slides file is edited in Drive, not here", "unsupported");
        if (o.baseRev !== undefined && String(existing.version) !== String(o.baseRev)) throw fail("the file changed in Drive since you opened it", "conflict");
        const r = await call(person, { method: "PATCH", path: `/upload/drive/v3/files/${existing.id}`, query: { uploadType: "media", fields: FIELDS, supportsAllDrives: true }, body: bytes }, "that file");
        return { id: String(r.id), rev: String(r.version) };
      }
      if (o.baseRev !== undefined) throw fail("the file is gone from Drive since you opened it", "conflict");
      const made = await call(person, { method: "POST", path: "/drive/v3/files", body: { name, parents: [dir] }, query: { fields: FIELDS, supportsAllDrives: true } }, "the folder");
      const r = await call(person, { method: "PATCH", path: `/upload/drive/v3/files/${made.id}`, query: { uploadType: "media", fields: FIELDS, supportsAllDrives: true }, body: bytes }, "that file");
      return { id: String(made.id), rev: String(r.version) };
    },
    /** @param {any} link @param {string} person @param {{ id: string }} entry @param {string} toPath */
    async rename(link, person, entry, toPath) {
      const root = rootOf(link), segs = segments(toPath), name = /** @type {string} */ (segs.pop());
      const id = String(entry && entry.id);
      if (!ID.test(id)) throw fail("that is not a Drive file", "bad_input");
      const dir = /** @type {string} */ (await dirAt(person, root, segs, true));
      const meta = await call(person, { path: `/drive/v3/files/${id}`, query: { fields: FIELDS, supportsAllDrives: true } }, "that file");
      const from = (meta.parents || [])[0];
      const r = await call(person, { method: "PATCH", path: `/drive/v3/files/${id}`, body: { name }, query: { fields: FIELDS, supportsAllDrives: true, ...(from && from !== dir ? { addParents: dir, removeParents: from } : {}) } }, "that file");
      return { id: String(r.id), rev: String(r.version) };
    },
    /** Trashes (Drive keeps it in its trash); never a permanent delete. @param {any} link @param {string} person @param {{ id: string }} entry */
    async delete(link, person, entry) {
      rootOf(link);
      const id = String(entry && entry.id);
      if (!ID.test(id)) throw fail("that is not a Drive file", "bad_input");
      await call(person, { method: "PATCH", path: `/drive/v3/files/${id}`, body: { trashed: true }, query: { fields: "id", supportsAllDrives: true } }, "that file");
      return { deleted: true };
    },
    /** @param {any} link @param {string} person @param {{ id: string }} entry */
    async versions(link, person, entry) {
      rootOf(link);
      const id = String(entry && entry.id);
      if (!ID.test(id)) throw fail("that is not a Drive file", "bad_input");
      const r = await call(person, { path: `/drive/v3/files/${id}/revisions`, query: { fields: "revisions(id,modifiedTime,lastModifyingUser(displayName))" } }, "that file");
      return (r.revisions || []).map((/** @type {any} */ v) => ({ rev: String(v.id), modified: Date.parse(v.modifiedTime) || 0, ...(v.lastModifyingUser && v.lastModifyingUser.displayName ? { by: String(v.lastModifyingUser.displayName) } : {}) }));
    },
  };
}
