// @ts-check
// Watcher definitions are hidden records (`def-watcher`), like Flow definitions (`def-flow`): the record is the definition, a person or Claude edits it the same way as any record, and the kernel
// authorizes, versions and audits the change. What a run does stays where it was: the schedule, cursor, failures and filed items are in the module's own SQLite tables, never in a record.
//
// The sandbox runs a watcher from two files (watch.js and watcher.json in its folder), and the hash that watchers.create pinned covers both, so the folder stays as the cache a run reads. `sync`
// keeps the record and the folder in step, once and idempotently:
//   - a folder with no record (a watcher written before this, or by Claude's write-a-watcher skill, which writes files) becomes a record: the one-time migration, and every later such write;
//   - a record with no folder (made or restored elsewhere) is written to the folder;
//   - both exist and differ: whichever changed since the last sync wins; if both did, the record wins (the record is the definition). An edited record or folder changes the hash, so a turned-on
//     watcher shows `changed` and waits for a new dry run and a yes, exactly as for any edit to its files.
// A record is never removed because a folder went away: only deleting a teammate's duty (the one watcher whose folder is removed too) forgets its record.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as folderMod from "./folder.js";

export const DEF = "def-watcher";
/** The hidden record type (declared in the module's manifest, `needs.kernel.types`; the kernel defines it). Two long text fields: the spec (watcher.json as written) and the code (watch.js). */
export const DEF_TYPE = Object.freeze({
  name: DEF, label: "Watcher", icon: "IconEye", fields: [
    { name: "name", kind: "text", label: "Name", required: true, unique: true },
    { name: "project", kind: "text", label: "Project" },
    { name: "schedule", kind: "text", label: "Runs" },
    { name: "hash", kind: "text", label: "Hash" },
    { name: "spec", kind: "text", label: "Settings (watcher.json)" },
    { name: "code", kind: "text", label: "Code (watch.js)" },
  ],
});

/** The same hash the folder reader makes of the two files. @param {string} spec @param {string} code */
export const hashOf = (spec, code) => crypto.createHash("sha256").update(spec).update("\0").update(code).digest("hex").slice(0, 32);

export const MIGRATIONS = [`CREATE TABLE watchers_defsync (name TEXT PRIMARY KEY, hash TEXT NOT NULL);`];

/**
 * @param {{ kernel: any, dir: string, db: import("node:sqlite").DatabaseSync, log?: (m: string) => void }} o
 */
export function createDefs({ kernel, dir, db, log = () => {} }) {
  const chain = () => kernel.serviceChain("watchers");
  const last = db.prepare("SELECT hash FROM watchers_defsync WHERE name = ?");
  const setLast = db.prepare("INSERT INTO watchers_defsync (name, hash) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash");
  const dropLast = db.prepare("DELETE FROM watchers_defsync WHERE name = ?");
  /** @type {Promise<any>} one sync at a time: the timer, a tool call and a restart's first look must not interleave */
  let busy = Promise.resolve();

  const readFolder = (/** @type {string} */ name) => {
    try {
      const spec = fs.readFileSync(path.join(dir, name, "watcher.json"), "utf8"), code = fs.readFileSync(path.join(dir, name, "watch.js"), "utf8");
      return { spec, code, hash: hashOf(spec, code) };
    } catch { return null; }
  };
  const writeFolder = (/** @type {string} */ name, /** @type {string} */ spec, /** @type {string} */ code) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "watcher.json"), spec);
    fs.writeFileSync(path.join(dir, name, "watch.js"), code);
  };
  const fieldsOf = (/** @type {string} */ name, /** @type {string} */ spec, /** @type {string} */ code) => {
    let j = {}; try { j = JSON.parse(spec); } catch { /* an invalid spec is kept as written */ }
    const o = /** @type {any} */ (j);
    return { name, spec, code, hash: hashOf(spec, code), ...(typeof o.project === "string" ? { project: o.project } : {}), ...(typeof o.schedule === "string" ? { schedule: o.schedule } : o.on ? { schedule: "event" } : {}) };
  };

  async function allRecords() {
    /** @type {Map<string, any>} */ const out = new Map();
    let cursor;
    for (let page = 0; page < 50; page++) {
      const r = await kernel.records.query(chain(), DEF, { page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const row of r.rows) out.set(String(row.data.name), row);
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    return out;
  }

  async function run() {
    const recs = await allRecords();
    const names = new Set([...folderMod.names(dir), ...recs.keys()]);
    const done = { created: 0, updated: 0, written: 0 };
    for (const name of names) {
      if (!folderMod.NAME.test(name)) continue;
      const f = readFolder(name), rec = recs.get(name);
      const was = /** @type {any} */ (last.get(name))?.hash;
      if (f && !rec) { await kernel.records.create(chain(), DEF, fieldsOf(name, f.spec, f.code)); setLast.run(name, f.hash); done.created++; continue; }
      if (!f && rec) { writeFolder(name, String(rec.data.spec || ""), String(rec.data.code || "")); setLast.run(name, hashOf(String(rec.data.spec || ""), String(rec.data.code || ""))); done.written++; continue; }
      if (!f || !rec) continue;
      const rh = hashOf(String(rec.data.spec || ""), String(rec.data.code || ""));
      if (rh === f.hash) { if (was !== f.hash) setLast.run(name, f.hash); if (rec.data.hash !== rh) await kernel.records.update(chain(), DEF, rec.id, { hash: rh }, rec.version); continue; }
      const folderChanged = was !== undefined && f.hash !== was, recordChanged = was !== undefined && rh !== was;
      if (folderChanged && !recordChanged) { await kernel.records.update(chain(), DEF, rec.id, fieldsOf(name, f.spec, f.code), rec.version); setLast.run(name, f.hash); done.updated++; }
      else {
        // the record changed (or both, or it was never synced): the record is the definition
        if (folderChanged && recordChanged) log(`watchers: ${name} changed in its folder and in its record; the record wins`);
        writeFolder(name, String(rec.data.spec || ""), String(rec.data.code || "")); setLast.run(name, rh); done.written++;
      }
    }
    return done;
  }

  return Object.freeze({
    /** Bring records and folders into step. Safe to call often. @returns {Promise<{ created: number, updated: number, written: number }>} */
    sync() { const p = busy.then(run, run); busy = p.catch(() => {}); return p; },
    /** A teammate's duty is deleted with its folder, so its definition goes too. @param {string} name */
    async forget(name) {
      const recs = await allRecords(); const rec = recs.get(name);
      if (rec) await kernel.records.remove(chain(), DEF, rec.id, rec.version);
      dropLast.run(name);
    },
    /** The definition record for a name, or null. @param {string} name */
    async get(name) { return (await allRecords()).get(name) || null; },
  });
}
