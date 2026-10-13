// @ts-check
// core/files/linked-index.js: the index of linked folders, kept PER PERSON. A linked folder is read through the person's own identity, so what one person can see is not what another can: each
// (link, person) pair has its own rows, its own change token and its own sync status, and a search only ever reads the asking person's rows. The index holds names, paths, dates and the text of
// text files (capped); the bytes of anything else are never fetched ahead, and a file's content is fetched again when it is opened (linked-read.js).
//
// A sync asks the provider for what changed since the stored token (a full listing the first time, or when asked), fetches text only for entries whose revision moved, drops what the source says
// is gone and, after a full listing, what it no longer shows this person. A failing source records its error and keeps the token and the old rows, so the next try resumes.
export const TEXT_CAP = 100_000;
/** A larger file is indexed by name only. */
export const TEXT_MAX_SIZE = 2 * 1024 * 1024;

export const INDEX_MIGRATIONS = [
  `CREATE TABLE files_linked_index (id INTEGER PRIMARY KEY, link TEXT NOT NULL, person TEXT NOT NULL, entry TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, mime TEXT, size INTEGER, modified INTEGER, rev TEXT, UNIQUE (link, person, entry));
   CREATE VIRTUAL TABLE files_linked_fts USING fts5(path, name, text);
   CREATE TABLE files_linked_sync (link TEXT NOT NULL, person TEXT NOT NULL, token TEXT, status TEXT NOT NULL, error TEXT, at INTEGER NOT NULL, PRIMARY KEY (link, person))`,
  `ALTER TABLE files_linked_index ADD COLUMN dir INTEGER NOT NULL DEFAULT 0`,
];

const isText = (/** @type {any} */ e) => e.indexable === true || /^text\//.test(String(e.mime || "")) || /^application\/(json|xml)$/.test(String(e.mime || ""));
const words = (/** @type {string} */ q) => (String(q).match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 12);

/** @param {{ db: any, providers: Map<string, any>, now?: () => number }} d */
export function linkedIndex({ db, providers, now = () => Date.now() }) {
  /** @type {Map<string, Promise<any>>} */ const running = new Map();
  const count = (/** @type {string} */ link, /** @type {string} */ person) => Number(db.prepare("SELECT COUNT(*) n FROM files_linked_index WHERE link = ? AND person = ?").get(link, person).n);
  const drop = (/** @type {number} */ id) => { db.prepare("DELETE FROM files_linked_fts WHERE rowid = ?").run(id); db.prepare("DELETE FROM files_linked_index WHERE id = ?").run(id); };
  const view = (/** @type {string} */ link, /** @type {string} */ person) => {
    const s = db.prepare("SELECT status, error, at FROM files_linked_sync WHERE link = ? AND person = ?").get(link, person);
    return s ? { status: String(s.status), ...(s.error ? { error: String(s.error) } : {}), at: Number(s.at), count: count(link, person) } : null;
  };

  async function run(/** @type {any} */ link, /** @type {string} */ person, /** @type {{ full?: boolean }} */ o) {
    const provider = providers.get(String(link.provider));
    const save = (/** @type {string} */ status, /** @type {string | null} */ error, /** @type {string | null | undefined} */ token) =>
      db.prepare("INSERT INTO files_linked_sync (link, person, token, status, error, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (link, person) DO UPDATE SET token = COALESCE(?, token), status = excluded.status, error = excluded.error, at = excluded.at")
        .run(link.id, person, token ?? null, status, error, now(), token ?? null);
    try {
      if (!provider) throw Object.assign(new Error(`no such source: ${link.provider}`), { code: "bad_input" });
      const prev = db.prepare("SELECT token FROM files_linked_sync WHERE link = ? AND person = ?").get(link.id, person);
      const r = await provider.list(link, person, o.full ? {} : { token: prev && prev.token != null ? String(prev.token) : undefined });
      const seen = new Set();
      for (const e of r.entries || []) {
        const id = String(e.id);
        seen.add(id);
        const have = db.prepare("SELECT id, rev FROM files_linked_index WHERE link = ? AND person = ? AND entry = ?").get(link.id, person, id);
        if (e.deleted) { if (have) drop(Number(have.id)); continue; }
        if (have && String(have.rev) === String(e.rev) && !o.full) continue;
        let text = "";
        if (isText(e) && Number(e.size || 0) <= TEXT_MAX_SIZE) {
          try { const f = await provider.read(link, person, e); text = Buffer.from(f.bytes).subarray(0, TEXT_CAP).toString("utf8"); } catch { text = ""; }
        }
        if (have) drop(Number(have.id));
        const ins = db.prepare("INSERT INTO files_linked_index (link, person, entry, path, name, mime, size, modified, rev, dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(link.id, person, id, String(e.path), String(e.name || String(e.path).split("/").pop()), e.mime ?? null, e.size ?? null, e.modified ?? null, String(e.rev), e.dir ? 1 : 0);
        db.prepare("INSERT INTO files_linked_fts (rowid, path, name, text) VALUES (?, ?, ?, ?)").run(ins.lastInsertRowid, String(e.path), String(e.name || ""), text);
      }
      if (r.full) for (const row of db.prepare("SELECT id, entry FROM files_linked_index WHERE link = ? AND person = ?").all(link.id, person)) if (!seen.has(row.entry)) drop(Number(row.id));
      save("ok", null, r.next == null ? null : String(r.next));
    } catch (e) {
      save("error", String(/** @type {any} */ (e).message || e).slice(0, 300), null);
    }
    return view(link.id, person);
  }

  return {
    /** Bring one person's index of one link up to date. A run already going for the same pair is joined. @param {any} link @param {string} person @param {{ full?: boolean }} [o] */
    sync(link, person, o = {}) {
      const key = `${link.id}\n${person}`;
      let p = running.get(key);
      if (!p) { p = run(link, person, o).finally(() => running.delete(key)); running.set(key, p); }
      return p;
    },
    status: view,
    /** Hits for one person, across their linked folders or one of them. @param {string} person @param {string} q @param {{ link?: string, limit?: number }} [o] */
    search(person, q, o = {}) {
      const w = words(q);
      if (!w.length) return [];
      const match = w.map((x, i) => `"${x}"${i === w.length - 1 ? "*" : ""}`).join(" ");
      const limit = Math.min(Math.max(Number(o.limit) || 20, 1), 100);
      return db.prepare(`SELECT i.link, i.entry, i.path, i.name, i.mime, i.size, i.modified, snippet(files_linked_fts, 2, '', '', '...', 12) AS snippet
          FROM files_linked_fts JOIN files_linked_index i ON i.id = files_linked_fts.rowid
          WHERE files_linked_fts MATCH ? AND i.person = ?${o.link ? " AND i.link = ?" : ""} ORDER BY rank LIMIT ?`)
        .all(match, person, ...(o.link ? [o.link] : []), limit).map((/** @type {any} */ r) => ({ ...r }));
    },
    /** The row at a path in one person's index, or null. @param {string} link @param {string} person @param {string} path */
    entryAt(link, person, path) {
      const r = db.prepare("SELECT entry, path, name, mime, size, modified, rev, dir FROM files_linked_index WHERE link = ? AND person = ? AND path = ?").get(link, person, path);
      return r ? { ...r, dir: Boolean(r.dir) } : null;
    },
    /** What is directly inside a folder ("" is the link's root) in one person's index; a folder only implied by deeper paths is listed too. @param {string} link @param {string} person @param {string} dir */
    children(link, person, dir) {
      const pre = dir ? `${dir}/` : "";
      const out = new Map();
      for (const r of db.prepare("SELECT entry, path, name, mime, size, modified, rev, dir FROM files_linked_index WHERE link = ? AND person = ? AND substr(path, 1, ?) = ? ORDER BY path").all(link, person, pre.length, pre)) {
        const rest = String(r.path).slice(pre.length);
        if (!rest) continue;
        const slash = rest.indexOf("/");
        if (slash < 0) out.set(rest, { ...r, dir: Boolean(r.dir) });
        else if (!out.has(rest.slice(0, slash))) out.set(rest.slice(0, slash), { entry: null, path: pre + rest.slice(0, slash), name: rest.slice(0, slash), mime: null, size: 0, modified: null, rev: null, dir: true });
      }
      return [...out.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    },
    /** Every row for a link, for every person: an unlinked folder leaves no index behind. @param {string} link */
    forget(link) {
      for (const r of db.prepare("SELECT id FROM files_linked_index WHERE link = ?").all(link)) db.prepare("DELETE FROM files_linked_fts WHERE rowid = ?").run(r.id);
      db.prepare("DELETE FROM files_linked_index WHERE link = ?").run(link);
      db.prepare("DELETE FROM files_linked_sync WHERE link = ?").run(link);
    },
    /** The (link, person) pairs that have been synced once, for a scheduler. */
    known() { return db.prepare("SELECT link, person FROM files_linked_sync").all().map((/** @type {any} */ r) => ({ link: String(r.link), person: String(r.person) })); },
  };
}
