// kernel/storage/drive.js: VyreDrive on the pool (DESIGN-space-storage.md): an owner's files by path, every version kept, backups beside them. The bytes live
// in the pool (encrypted before they leave the home, copies by class); this index of paths and versions lives with the pool's own index on the home.
// The gateway decides who may read or write (the drive.* actions in seal/uses.js) and calls these methods; nothing here checks a grant.
//   - the newest version of a file is working data (home plus a replica); older versions are cold, and unchanged chunks cost nothing because chunks dedupe
//   - two writers on one file give two versions, never a merge: a write whose `base` is not the head is kept beside it and marked `conflict`, and a person picks
//   - a delete is a version too (a tombstone), so it can be undone; `prune` is what finally lets old versions go
//   - a sealed value is never stored here: sealed derivatives stay in the sealing process's folder and a project holds only a reference file (seal/placement.js)
import fs from "node:fs";
import path from "node:path";
import { safePath } from "../seal/uses.js";

const err = (code, message = code) => Object.assign(new Error(message), { code });
const MAX_PATH = 1024;

export class Drive {
  /** @param {import("./pool.js").Pool} pool @param {{ now?: () => number }} [o] */
  constructor(pool, { now = pool.now } = {}) {
    this.pool = pool; this.chain = new Map(); this.now = now; this.file = path.join(pool.dir, "drive.json");
    this.ix = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : { v: 1, files: {}, backups: {} };
  }
  save() { const t = `${this.file}.tmp`; fs.writeFileSync(t, JSON.stringify(this.ix), { mode: 0o600 }); fs.renameSync(t, this.file); }
  path(p) { const s = String(p ?? ""); if (s.length > MAX_PATH) throw err("bad_path"); try { return safePath(s); } catch { throw err("bad_path"); } }
  /** One change to a path at a time. */
  turn(k, fn) { const prev = this.chain.get(k) ?? Promise.resolve(), run = prev.then(fn, fn), tail = run.catch(() => {}); this.chain.set(k, tail); return run.finally(() => { if (this.chain.get(k) === tail) this.chain.delete(k); }); }
  head(f) { return f.versions.at(-1); }

  /** @returns {Promise<{ version: number, conflict: boolean, atRisk: boolean }>} `base` is the version the writer started from (omit for a new file). */
  async put(p, bytes, { by = null, base = null, meter = null } = {}) {
    const k = this.path(p), r = await this.pool.put(bytes, { class: "working", meter });
    // The head, the version number and the conflict are decided inside the path's turn, after the bytes are stored (S-1): two writers at once get two versions.
    return this.turn(k, async () => {
      const f = (this.ix.files[k] ??= { versions: [] }), h = f.versions.at(-1), conflict = !!h && base !== h.ver, ver = (h?.ver ?? 0) + 1;
      f.versions.push({ ver, id: r.id, size: r.size, at: this.now(), by, base, ...(conflict ? { conflict: true } : {}) });
      // The version before is no longer the newest: it becomes cold. A conflicting write leaves the head's own class alone only until a person picks, so both stay working.
      if (h && !h.deleted && !conflict) await this.pool.reclass(h.id, "cold");
      this.save(); return { version: ver, conflict, atRisk: r.atRisk };
    });
  }
  /** The head, or a named version. A deleted file is not found unless a version is asked for. */
  async get(p, { version = null } = {}) {
    const f = this.ix.files[this.path(p)]; if (!f) throw err("not_found");
    const v = version === null ? this.head(f) : f.versions.find(x => x.ver === version);
    if (!v || (version === null && v.deleted)) throw err("not_found");
    if (v.deleted) throw err("deleted_version");
    return this.pool.get(v.id);
  }
  /** Files under a prefix, newest version each, deleted ones left out. Names and sizes only. */
  list(prefix = "") {
    const pre = prefix ? this.path(prefix).replace(/\/?$/, "/") : "";
    return Object.entries(this.ix.files).filter(([k, f]) => k.startsWith(pre) && !this.head(f).deleted).map(([k, f]) => ({ path: k, size: this.head(f).size, version: this.head(f).ver, at: this.head(f).at, conflicts: f.versions.filter(v => v.conflict && !v.resolved).length })).sort((a, b) => (a.path < b.path ? -1 : 1));
  }
  history(p) { const f = this.ix.files[this.path(p)]; if (!f) throw err("not_found"); return f.versions.map(({ ver, size, at, by, base, deleted, conflict }) => ({ ver, size, at, by, base, deleted: !!deleted, conflict: !!conflict })); }
  delete(p, { by = null } = {}) {
    const k = this.path(p);
    return this.turn(k, async () => {
      const f = this.ix.files[k]; if (!f || this.head(f).deleted) throw err("not_found");
      const h = this.head(f); f.versions.push({ ver: h.ver + 1, id: null, size: 0, at: this.now(), by, base: h.ver, deleted: true });
      await this.pool.reclass(h.id, "cold"); this.save(); return { version: h.ver + 1 };
    });
  }
  /** Make an older version the newest again (a restore is a new version, so nothing is lost), which also settles a conflict. */
  restore(p, version, { by = null } = {}) {
    const k = this.path(p);
    return this.turn(k, async () => {
      const f = this.ix.files[k], v = f?.versions.find(x => x.ver === version); if (!v || v.deleted) throw err("not_found");
      const h = this.head(f), r = await this.pool.put(await this.pool.get(v.id), { class: "working" }), ver = h.ver + 1;
      f.versions.push({ ver, id: r.id, size: r.size, at: this.now(), by, base: h.ver, restored_from: version });
      for (const x of f.versions) if (x.conflict) x.resolved = true;
      for (const x of f.versions) if (x.id && x.ver !== ver && !x.deleted && x.class !== "cold") { x.class = "cold"; await this.pool.reclass(x.id, "cold"); }
      this.save(); return { version: ver };
    });
  }
  /** Let old versions go: keep the newest `keep` of each file and anything younger than `olderThanMs`. Returns bytes freed. */
  async prune({ keep = 10, olderThanMs = 30 * 86_400_000 } = {}) {
    let freed = 0;
    for (const f of Object.values(this.ix.files)) {
      const old = f.versions.slice(0, -keep).filter(v => this.now() - v.at > olderThanMs && v.id);
      for (const v of old) { freed += v.size; await this.pool.remove(v.id); v.id = null; v.pruned = true; }
    }
    this.save(); return { freed };
  }

  /** Backups: the space's encrypted backups, class backup (at least one copy off the home). */
  async backup(name, bytes, { meter = "backup" } = {}) {
    const r = await this.pool.put(bytes, { class: "backup", meter }); (this.ix.backups[name] ??= []).push({ id: r.id, size: r.size, at: this.now() }); this.save(); return { id: r.id, atRisk: r.atRisk };
  }
  backups(name) { return (this.ix.backups[name] ?? []).map(({ id, size, at }) => ({ id, size, at })); }
  async restoreBackup(name, id = null) { const l = this.ix.backups[name] ?? [], b = id ? l.find(x => x.id === id) : l.at(-1); if (!b) throw err("not_found"); return this.pool.get(b.id); }
  /** Keep the newest `keep` backups of a name. The last one is never removed. */
  async pruneBackups(name, keep = 7) {
    const l = this.ix.backups[name] ?? [], gone = l.slice(0, Math.max(0, l.length - Math.max(1, keep)));
    for (const b of gone) await this.pool.remove(b.id); this.ix.backups[name] = l.slice(gone.length); this.save(); return { removed: gone.length };
  }
}
