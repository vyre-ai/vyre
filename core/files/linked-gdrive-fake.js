// @ts-check
// A fake Google Drive REST API for tests: the few v3 calls linked-gdrive.js makes, over an in-memory tree, with a change log, revisions and per-person visibility. It answers the same shapes as
// Google and reaches nothing. `request(person, req)` is the seam the provider is built on (the real one is the Google module's `request`, bound to the person's account).
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";

/** @param {{ pageSize?: number }} [o] */
export function fakeDriveApi({ pageSize = 1000 } = {}) {
  /** @type {Map<string, any>} */ const files = new Map();
  /** @type {{ seq: number, id: string }[]} */ const log = [];
  /** @type {Map<string, Set<string>>} */ const hidden = new Map();
  const calls = /** @type {any[]} */ ([]);
  let seq = 0, n = 0;
  const err = (/** @type {number} */ status, /** @type {string} */ code) => Object.assign(new Error(`drive ${status}`), { status, code });
  const touch = (/** @type {any} */ f) => { f.version = String(Number(f.version || 0) + 1); f.modifiedTime = new Date(1_700_000_000_000 + ++seq * 1000).toISOString(); log.push({ seq, id: f.id }); };
  const meta = (/** @type {any} */ f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: [...f.parents], trashed: Boolean(f.trashed), version: f.version, modifiedTime: f.modifiedTime, ...(f.mimeType === FOLDER || f.mimeType === DOC ? {} : { size: String(f.bytes.length) }) });
  const seen = (/** @type {string} */ person, /** @type {string} */ id) => files.has(id) && !(hidden.get(person) || new Set()).has(id);
  const need = (/** @type {string} */ person, /** @type {string} */ id) => { if (!seen(person, id)) throw err(404, "not_found"); return files.get(id); };

  const api = {
    calls, files,
    /** Add a file or folder at the source (not through Vyre). @param {{ id?: string, name: string, parent?: string, folder?: boolean, doc?: boolean, text?: string }} o */
    add(o) {
      const id = o.id || `d${++n}`;
      const f = { id, name: o.name, mimeType: o.folder ? FOLDER : o.doc ? DOC : (/\.md$/.test(o.name) ? "text/markdown" : /\.png$/.test(o.name) ? "image/png" : "text/plain"), parents: o.parent ? [o.parent] : [], bytes: Buffer.from(o.text || ""), version: "0", revisions: [] };
      files.set(id, f); touch(f); f.revisions.push({ id: `r${f.version}`, modifiedTime: f.modifiedTime });
      return id;
    },
    /** @param {string} id @param {string} text */
    edit(id, text) { const f = files.get(id); f.bytes = Buffer.from(text); touch(f); f.revisions.push({ id: `r${f.version}`, modifiedTime: f.modifiedTime }); },
    /** @param {string} id */
    trash(id) { const f = files.get(id); f.trashed = true; touch(f); },
    /** a person who cannot see a file at all @param {string} person @param {string} id */
    hide(person, id) { if (!hidden.has(person)) hidden.set(person, new Set()); /** @type {Set<string>} */ (hidden.get(person)).add(id); },
    /** @param {string} person @param {{ method?: string, path: string, query?: any, body?: any, raw?: boolean }} req */
    async request(person, req) {
      calls.push([person, req.method || "GET", req.path, req.query || {}]);
      const m = req.method || "GET", p = req.path, q = req.query || {};
      if (m === "GET" && p === "/drive/v3/files") {
        const parent = /'([^']+)' in parents/.exec(String(q.q || ""));
        if (!parent) throw err(400, "bad_query");
        if (!seen(person, parent[1])) throw err(404, "not_found");
        const nm = /name = '((?:[^'\\]|\\.)*)'/.exec(String(q.q || ""));
        const want = nm ? nm[1].replace(/\\(.)/g, "$1") : null;
        const all = [...files.values()].filter(f => f.parents.includes(parent[1]) && !f.trashed && seen(person, f.id) && (want === null || f.name === want));
        const start = Number(q.pageToken || 0), size = Math.min(Number(q.pageSize) || pageSize, pageSize);
        const page = all.slice(start, start + size).map(meta);
        return { files: page, ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) };
      }
      if (m === "GET" && p === "/drive/v3/changes/startPageToken") return { startPageToken: String(seq) };
      if (m === "GET" && p === "/drive/v3/changes") {
        const since = Number(q.pageToken);
        const ids = [...new Set(log.filter(l => l.seq > since).map(l => l.id))].filter(id => seen(person, id));
        return { changes: ids.map(id => ({ fileId: id, removed: false, file: meta(files.get(id)) })), newStartPageToken: String(seq) };
      }
      let mm = /^\/drive\/v3\/files\/([^/]+)(\/export|\/revisions)?$/.exec(p);
      if (m === "GET" && mm) {
        const f = need(person, mm[1]);
        if (mm[2] === "/revisions") return { revisions: f.revisions.map((/** @type {any} */ r) => ({ ...r, lastModifyingUser: { displayName: "Someone" } })) };
        if (mm[2] === "/export") { if (f.mimeType !== DOC) throw err(403, "not_exportable"); return { bytes: new Uint8Array(f.bytes), mime: String(q.mimeType) }; }
        if (q.alt === "media") { if (f.mimeType === DOC || f.mimeType === FOLDER) throw err(403, "use_export"); return { bytes: new Uint8Array(f.bytes), mime: f.mimeType }; }
        return meta(f);
      }
      mm = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
      if (m === "PATCH" && mm) { const f = need(person, mm[1]); f.bytes = Buffer.from(req.body); touch(f); f.revisions.push({ id: `r${f.version}`, modifiedTime: f.modifiedTime }); return meta(f); }
      if (m === "POST" && p === "/drive/v3/files") {
        const parent = (req.body.parents || [])[0];
        if (!seen(person, parent)) throw err(404, "not_found");
        return meta(files.get(api.add({ name: req.body.name, parent, folder: req.body.mimeType === FOLDER })));
      }
      mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
      if (m === "PATCH" && mm) {
        const f = need(person, mm[1]);
        if (req.body && req.body.name) f.name = req.body.name;
        if (req.body && req.body.trashed === true) f.trashed = true;
        if (q.removeParents) f.parents = f.parents.filter((/** @type {string} */ x) => x !== q.removeParents);
        if (q.addParents) f.parents.push(q.addParents);
        touch(f); return meta(f);
      }
      throw err(400, "unsupported_in_fake");
    },
  };
  return api;
}
