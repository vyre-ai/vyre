// @ts-check
// A fake Dropbox API v2 for tests: the few files/* calls linked-dropbox.js makes, over an in-memory tree with case-insensitive paths, list_folder cursors and a change feed (a deleted entry has a
// path and no id, as at Dropbox), revisions, "conflicted copy" on a lost update race, and per-person visibility. It reaches nothing. `request(person, req)` is the seam the provider is built on;
// `dropboxFetch(api, tokens)` wraps the same fake as a fetch, so the real seam (dropbox-seam.js) can be exercised end to end. files/delete_v2 is answered but counted: a test asserts it stays at zero.

/** @param {{ pageSize?: number, conflicts?: "copy" | "error" }} [o] */
export function fakeDropboxApi({ pageSize = 2000, conflicts = "copy" } = {}) {
  /** @type {Map<string, any>} */ const nodes = new Map();
  /** @type {{ seq: number, id: string, old?: string }[]} */ const log = [];
  /** @type {Map<string, Set<string>>} */ const hidden = new Map();
  /** @type {Map<string, any[]>} */ const pages = new Map();
  const calls = /** @type {any[]} */ ([]);
  let seq = 0, n = 0, epoch = 0, pageN = 0;
  /** @type {null | (() => void)} */ let beforeUpload = null;
  const err = (/** @type {number} */ status, /** @type {string} */ message) => Object.assign(new Error(message), { status });
  const low = (/** @type {string} */ p) => p.toLowerCase();
  const base = (/** @type {string} */ p) => p.slice(p.lastIndexOf("/") + 1);
  const touch = (/** @type {any} */ f) => { f.rev = `r${++n}`; f.mtime = 1_700_000_000_000 + ++seq * 1000; log.push({ seq, id: f.id }); if (f.tag === "file") f.revisions.push({ rev: f.rev, mtime: f.mtime }); };
  const live = (/** @type {string} */ p) => [...nodes.values()].find(x => !x.deleted && low(x.path) === low(p));
  const meta = (/** @type {any} */ f) => ({ ".tag": f.tag, id: f.id, name: base(f.path), path_lower: low(f.path), path_display: f.path, ...(f.tag === "file" ? { rev: f.rev, size: f.bytes.length, server_modified: new Date(f.mtime).toISOString(), is_downloadable: true } : {}) });
  const seen = (/** @type {string} */ person, /** @type {any} */ f) => !f.deleted && ![...(hidden.get(person) || [])].some(h => low(f.path) === h || low(f.path).startsWith(h + "/"));
  const under = (/** @type {any} */ f, /** @type {string} */ root, /** @type {boolean} */ recursive) => { const lp = low(f.path); if (!lp.startsWith(root + "/")) return false; return recursive || !lp.slice(root.length + 1).includes("/"); };
  const need = (/** @type {string} */ person, /** @type {string} */ ref, /** @type {string} */ field = "path") => {
    const f = ref.startsWith("id:") ? nodes.get(ref) : live(ref);
    if (!f || !seen(person, f)) throw err(409, `${field}/not_found/.`);
    return f;
  };
  const ancestors = (/** @type {string} */ p) => { const parts = p.split("/").slice(1, -1); let cur = ""; for (const part of parts) { cur += "/" + part; if (!live(cur)) api.add({ path: cur, folder: true }); } };
  const cursorOf = (/** @type {string} */ root) => `c${epoch}|${seq}|${root}`;

  const api = {
    calls, nodes,
    get permanentDeletes() { return calls.filter(c => /delete/.test(String(c[1]))).length; },
    /** a change at the source, not through Vyre. @param {{ path: string, text?: string, folder?: boolean }} o */
    add(o) {
      const existing = live(o.path);
      if (existing) { if (o.text !== undefined) api.edit(o.path, o.text); return existing.id; }
      ancestors(o.path);
      const id = `id:f${++n}`;
      const f = { id, path: o.path, tag: o.folder ? "folder" : "file", bytes: Buffer.from(o.text || ""), rev: "", mtime: 0, revisions: /** @type {any[]} */ ([]) };
      nodes.set(id, f); touch(f);
      return id;
    },
    /** @param {string} path @param {string} text */
    edit(path, text) { const f = live(path); f.bytes = Buffer.from(text); touch(f); },
    /** @param {string} path */
    remove(path) { for (const f of [...nodes.values()]) if (!f.deleted && (low(f.path) === low(path) || low(f.path).startsWith(low(path) + "/"))) { f.deleted = true; f.goneAt = ++seq; log.push({ seq, id: f.id }); } },
    /** a person who cannot see a path @param {string} person @param {string} path */
    hide(person, path) { if (!hidden.has(person)) hidden.set(person, new Set()); /** @type {Set<string>} */ (hidden.get(person)).add(low(path)); },
    /** a cursor taken before now no longer works (Dropbox answers reset) */
    expireCursors() { epoch += 1; },
    /** runs after the upload's checks and before it writes: a lost race. @param {null | (() => void)} fn */
    beforeUpload(fn) { beforeUpload = fn; },
    /** @param {string} person @param {{ path: string, args?: any, body?: Uint8Array, raw?: boolean }} req */
    async request(person, req) {
      const p = String(req.path), a = req.args || {};
      calls.push([person, p.replace("/2/files/", ""), a.path ?? a.from_path ?? ""]);
      if (p === "/2/files/get_metadata") return meta(need(person, String(a.path)));
      if (p === "/2/files/list_folder" || p === "/2/files/list_folder/get_latest_cursor") {
        const root = low(String(a.path));
        if (root !== "") { const r = live(root); if (!r || !seen(person, r) || r.tag !== "folder") throw err(409, "path/not_found/."); }
        if (p.endsWith("get_latest_cursor")) return { cursor: cursorOf(root) };
        const all = [...nodes.values()].filter(f => seen(person, f) && (root === "" ? (a.recursive || !f.path.slice(1).includes("/")) : under(f, root, Boolean(a.recursive)))).map(meta);
        const size = Math.min(Number(a.limit) || pageSize, pageSize);
        return page(all, 0, size, root);
      }
      if (p === "/2/files/list_folder/continue") {
        const cur = String(a.cursor);
        if (cur.startsWith("p")) { const st = /** @type {any} */ (pages.get(cur)); if (!st) throw err(409, "reset/."); return page(st.all, st.at, st.size, st.root); }
        const [e, since, root] = [cur.split("|")[0].slice(1), Number(cur.split("|")[1]), cur.split("|").slice(2).join("|")];
        if (Number(e) !== epoch) throw err(409, "reset/.");
        const since2 = log.filter(l => l.seq > since);
        /** @type {any[]} */ const entries = [];
        for (const l of since2) if (l.old && low(l.old).startsWith(root + "/")) entries.push({ ".tag": "deleted", name: base(l.old), path_lower: low(l.old), path_display: l.old });
        for (const id of new Set(since2.map(l => l.id))) {
          const f = nodes.get(id); if (!f) continue;
          if (f.deleted || !seen(person, f)) { if (low(f.path).startsWith(root + "/")) entries.push({ ".tag": "deleted", name: base(f.path), path_lower: low(f.path), path_display: f.path }); continue; }
          if (under(f, root, true)) entries.push(meta(f));
        }
        return { entries, cursor: cursorOf(root), has_more: false };
      }
      if (p === "/2/files/download") {
        const f = need(person, String(a.path));
        if (f.tag !== "file") throw err(409, "path/not_file/.");
        return { bytes: new Uint8Array(f.bytes), result: meta(f) };
      }
      if (p === "/2/files/upload") {
        const target = String(a.path), mode = a.mode || {}, existing = live(target);
        if (beforeUpload) { const fn = beforeUpload; beforeUpload = null; fn(); }
        const now = live(target);
        if (mode[".tag"] === "add" && now) throw err(409, "path/conflict/file/.");
        if (mode[".tag"] === "update" && now && now.rev !== mode.update) {
          if (conflicts === "error") throw err(409, "path/conflict/file/.");
          const dot = target.lastIndexOf(".");
          const copy = dot > target.lastIndexOf("/") ? `${target.slice(0, dot)} (conflicted copy)${target.slice(dot)}` : `${target} (conflicted copy)`;
          return meta(nodes.get(api.add({ path: copy, text: Buffer.from(req.body || []).toString() })));
        }
        void existing;
        ancestors(target);
        if (now) { now.bytes = Buffer.from(req.body || []); touch(now); return meta(now); }
        return meta(nodes.get(api.add({ path: target, text: Buffer.from(req.body || []).toString() })));
      }
      if (p === "/2/files/create_folder_v2") {
        if (live(String(a.path))) throw err(409, "path/conflict/folder/.");
        return { metadata: meta(nodes.get(api.add({ path: String(a.path), folder: true }))) };
      }
      if (p === "/2/files/move_v2") {
        const f = need(person, String(a.from_path), "from_lookup");
        let to = String(a.to_path);
        const parent = to.slice(0, to.lastIndexOf("/"));
        if (parent && !live(parent)) throw err(409, "to/not_found/.");
        if (live(to) && live(to) !== f) {
          if (!a.autorename) throw err(409, "to/conflict/file/.");
          const dot = to.lastIndexOf("."), hasExt = dot > to.lastIndexOf("/");
          for (let i = 1; live(to); i++) to = hasExt ? `${String(a.to_path).slice(0, dot)} (${i})${String(a.to_path).slice(dot)}` : `${a.to_path} (${i})`;
        }
        const from = f.path;
        for (const k of [...nodes.values()]) if (!k.deleted && (k === f || low(k.path).startsWith(low(from) + "/"))) { const was = k.path; k.path = to + k.path.slice(from.length); touch(k); /** @type {any} */ (log[log.length - 1]).old = was; }
        return { metadata: meta(f) };
      }
      if (p === "/2/files/list_revisions") {
        const f = need(person, String(a.path));
        return { entries: f.revisions.map((/** @type {any} */ r) => ({ rev: r.rev, server_modified: new Date(r.mtime).toISOString() })) };
      }
      if (p === "/2/files/delete_v2") throw err(409, "permanent delete is not allowed in this test");
      throw err(400, "unsupported_in_fake");
    },
  };
  function page(/** @type {any[]} */ all, /** @type {number} */ at, /** @type {number} */ size, /** @type {string} */ root) {
    const entries = all.slice(at, at + size);
    if (at + size >= all.length) return { entries, cursor: cursorOf(root), has_more: false };
    const id = `p${++pageN}`; pages.set(id, { all, at: at + size, size, root });
    return { entries, cursor: id, has_more: true };
  }
  return api;
}

/**
 * The fake as a fetch (what dropbox-seam.js calls), so the real seam runs against it. `tokens` maps a bearer token to the person it was issued to; a token that is not in it is a 401.
 * Every URL fetched is recorded in `.urls`, and so is each init.
 * @param {ReturnType<typeof fakeDropboxApi>} api @param {Record<string, string>} tokens
 */
export function dropboxFetch(api, tokens) {
  const urls = /** @type {string[]} */ ([]), inits = /** @type {any[]} */ ([]);
  /** @type {typeof fetch} */
  const f = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    urls.push(String(url)); inits.push(init);
    const u = new URL(String(url));
    const person = tokens[String(init.headers.Authorization || "").replace(/^Bearer /, "")];
    if (!person) return new Response(JSON.stringify({ error_summary: "invalid_access_token/.", error: { ".tag": "invalid_access_token" } }), { status: 401 });
    const content = u.hostname === "content.dropboxapi.com";
    const args = content ? JSON.parse(init.headers["Dropbox-API-Arg"]) : JSON.parse(init.body || "{}");
    try {
      const r = await api.request(person, { path: u.pathname, args, ...(content && init.body ? { body: init.body } : {}) });
      if (u.pathname === "/2/files/download") return new Response(r.bytes, { status: 200, headers: { "dropbox-api-result": JSON.stringify(r.result) } });
      return new Response(JSON.stringify(r), { status: 200 });
    } catch (e) {
      const err = /** @type {any} */ (e);
      return new Response(JSON.stringify({ error_summary: err.message }), { status: Number(err.status) || 500 });
    }
  });
  return Object.assign(f, { urls, inits });
}
