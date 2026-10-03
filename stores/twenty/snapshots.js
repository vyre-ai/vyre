// @ts-check
// The gateway-side snapshot of every record version the store has seen (spec 3.3 rule 3). Twenty's
// webhook carries no "before", so a change made inside Twenty gets its before from here. Append-only
// lines on disk, last write wins on load, compacted when it has grown to twice the live size.

import fs from "node:fs";
import path from "node:path";

/** @typedef {{ version: string, hash: string, fields: Record<string, any> }} Snap */
export class SnapshotStore {
  /** @param {string | null} file */
  constructor(file) {
    this.file = file;
    /** @type {Map<string, Snap>} */ this.map = new Map();
    this.lines = 0;
    if (file && fs.existsSync(file)) {
      for (const l of fs.readFileSync(file, "utf8").split("\n")) {
        if (!l) continue;
        try { const [k, v] = JSON.parse(l); if (v === null) this.map.delete(k); else this.map.set(k, v); this.lines++; } catch { /* a torn last line */ }
      }
    }
  }
  /** @param {string} type @param {string} id */ static key(type, id) { return `${type}/${id}`; }
  /** @param {string} type @param {string} id @returns {Snap | undefined} */
  get(type, id) { return this.map.get(SnapshotStore.key(type, id)); }
  /** @param {string} type @param {string} id @param {Snap | null} snap */
  set(type, id, snap) {
    const k = SnapshotStore.key(type, id);
    if (snap === null) this.map.delete(k); else this.map.set(k, snap);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, JSON.stringify([k, snap]) + "\n", { mode: 0o600 });
      if (++this.lines > 1000 && this.lines > 2 * this.map.size) this.compact();
    }
  }
  compact() {
    if (!this.file) return;
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, [...this.map].map(([k, v]) => JSON.stringify([k, v])).join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.lines = this.map.size;
  }
}
