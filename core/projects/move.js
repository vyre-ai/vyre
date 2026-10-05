// @ts-check
// move: once, on a box, project homes leave ~/Vyre/projects for the work folder.
//
// ~/Vyre/projects sits in the vyre-home volume with the vault and Claude's sign-in, which is
// never shared. /work/projects is in the vyre-work volume, which VyreDrive shares. A project
// home is a folder directly inside the old folder that holds a marker; anything else stays put.
// Each moved home leaves a symlink behind, because Claude Code keys a session's transcript by
// its folder and a session started in the old path must still resume. What this module stores
// (the rows, and the markers' folders) is rewritten to the new paths. The outcome is written to
// <vyre home>/projects-moved.json, and while that file is there this never runs again.
//
// Nothing runs it on its own: the owner runs `projects.move` (./index.js), first as a dry run.

import fs from "node:fs";
import path from "node:path";
import * as M from "./markers.js";
import { MOVED_RECORD } from "../config/index.js";

/** The record, in the vyre home. config.load reads it too, to know the box's homes moved. */
export const RECORD = MOVED_RECORD;

/** @typedef {{ from: string, to: string, moved: string[], skipped: Array<{ slug: string, why: string }>, at: number,
 *   rewrites?: Array<{ marker: string, workspaces: string[] } | { row: string, home: string, spec: string }> }} Outcome
 * rewrites is in the answer only; the record and the event keep the outcome without it. */

const exists = (/** @type {string} */ p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isDir = (/** @type {string} */ p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Move one folder. Docker volumes are different filesystems, so a rename there fails with EXDEV:
 * then copy (timestamps and symlinks as they are) and remove the source.
 * @param {string} src @param {string} dst @param {(a: string, b: string) => void} rename
 * @returns {"renamed"|"copied"}
 */
function moveDir(src, dst, rename) {
  try { rename(src, dst); return "renamed"; }
  catch (e) { if (/** @type {any} */ (e).code !== "EXDEV") throw e; }
  try { fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false }); }
  catch (e) { fs.rmSync(dst, { recursive: true, force: true }); throw e; }
  fs.rmSync(src, { recursive: true, force: true });
  return "copied";
}

/**
 * Move the project homes in `from` into `to`, once. Returns what happened, or null when there was
 * nothing to do (already done, or no old folder).
 *
 * With `dryRun`, the same walk runs and answers the same outcome (moved, skipped with why, and the
 * marker and row rewrites as `rewrites`), but nothing on disk, in the db or in the record changes,
 * and nothing is emitted or logged. The real run and the dry run share every decision; only the
 * steps that change something go through `act`, which a dry run replaces with a no-op. A move that
 * fails when it is tried (a permission, a full disk) cannot be foreseen, so a dry run counts it as
 * moved; the real run then skips it and says why.
 * @param {{ db: import("node:sqlite").DatabaseSync, from: string, to: string, root: string,
 *   log?: (msg: string) => void, emit?: (type: string, payload: object) => void,
 *   rename?: (a: string, b: string) => void, now?: () => number, dryRun?: boolean }} o
 * @returns {Outcome|null}
 */
export function moveProjects({ db, from, to, root, log = () => {}, emit = () => {}, rename = fs.renameSync, now = Date.now, dryRun = false }) {
  const record = path.join(root, RECORD);
  if (exists(record)) return null;
  if (!isDir(from)) return null;
  const src0 = M.real(from), dst0 = M.real(to);
  if (src0 === dst0 || dst0.startsWith(src0 + path.sep) || src0.startsWith(dst0 + path.sep)) return null;
  if (dryRun) log = () => {};
  /** Every step that changes something. A dry run does none of them and reports as if each worked. */
  const act = dryRun
    ? { mkdir: () => {}, move: () => "renamed", link: () => {}, marker: () => {}, rows: () => {}, record: () => {}, emit: () => {} }
    : {
        mkdir: (/** @type {string} */ d) => fs.mkdirSync(d, { recursive: true }),
        move: (/** @type {string} */ a, /** @type {string} */ b) => moveDir(a, b, rename),
        link: (/** @type {string} */ target, /** @type {string} */ at) => fs.symlinkSync(target, at, "dir"),
        marker: (/** @type {string} */ home, /** @type {string[]} */ ws) => M.write(home, { workspaces: ws }),
        rows: (/** @type {Array<{ slug: string, home: string, spec: string }>} */ list) => {
          const up = db.prepare("UPDATE projects_projects SET home = ?, spec = ? WHERE slug = ?");
          db.exec("BEGIN");
          try { for (const r of list) up.run(r.home, r.spec, r.slug); db.exec("COMMIT"); }
          catch (e) { db.exec("ROLLBACK"); throw e; }
        },
        record: (/** @type {Outcome} */ o) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(record, JSON.stringify(o, null, 2) + "\n"); },
        emit,
      };
  act.mkdir(to);
  // The resolved destination is the same before the folder is made: real() resolves a missing
  // folder through its nearest parent that exists.
  const dstDir = M.real(to);
  log(`moving project homes from ${from} to ${to}`);

  /** @type {Outcome} */
  const out = { from, to, moved: [], skipped: [], at: now() };
  /** @type {Array<{ marker: string, workspaces: string[] } | { row: string, home: string, spec: string }>} */
  const rewrites = [];
  /** Old path to new path, for each moved home: both as found in the folder and resolved. */
  /** @type {Array<[string, string]>} */
  const pairs = [];
  /** @type {Array<{ home: string, workspaces: string[] }>} */
  const movedHomes = [];
  let entries = [];
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch (e) { log(`could not read ${from}: ${/** @type {Error} */ (e).message}`); }
  // Only real folders: a symlink here is a home already moved, and is left alone.
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const src = path.join(from, e.name);
    const p = M.load(src);
    if (!p) continue;
    const dst = path.join(dstDir, e.name);
    if (exists(dst)) {
      const why = `${dst} already exists`;
      out.skipped.push({ slug: p.slug, why });
      log(`not moving ${p.slug}: ${why}`);
      continue;
    }
    let how;
    try { how = act.move(src, dst); }
    catch (err) {
      const why = `could not move: ${/** @type {Error} */ (err).message}`;
      out.skipped.push({ slug: p.slug, why });
      log(`not moving ${p.slug}: ${why}`);
      continue;
    }
    try { act.link(dst, src); }
    catch (err) { log(`moved ${p.slug} but could not leave a link at ${src}: ${/** @type {Error} */ (err).message}`); }
    pairs.push([p.home, dst]);
    if (path.resolve(src) !== p.home) pairs.push([path.resolve(src), dst]);
    movedHomes.push({ home: dst, workspaces: p.workspaces });
    out.moved.push(p.slug);
    log(`moved ${p.slug} to ${dst} (${how})`);
  }

  /** A path under a moved home, at its new place; any other path as it was. */
  const remap = (/** @type {string} */ p) => {
    for (const [a, b] of pairs) if (p === a || p.startsWith(a + path.sep)) return b + p.slice(a.length);
    return p;
  };
  const remapAll = (/** @type {string[]} */ list) => list.map(w => remap(String(w)));

  if (pairs.length) {
    // The markers: folders are stored relative to the home, so a moved home's own folders still
    // resolve, but a folder given outside it would now point somewhere else. Each is written again
    // from its absolute path before the move. A marker with only its home is left untouched.
    const rows = db.prepare("SELECT slug, home, spec FROM projects_projects").all();
    const markers = new Map(movedHomes.map(h => [h.home, h.workspaces]));
    for (const r of rows) {
      const home = String(r.home);
      if (markers.has(remap(home))) continue;
      let spec = null;
      try { spec = JSON.parse(String(r.spec)); } catch {}
      const ws = spec && Array.isArray(spec.workspaces) ? spec.workspaces.map(String) : [];
      if (ws.some(w => remap(w) !== w)) markers.set(home, ws);
    }
    for (const [home, ws] of markers) {
      const next = remapAll(ws).filter(w => w !== home);
      const before = ws.filter(w => remap(w) !== home);
      if (!before.length) continue;
      const rel = M.relative(home, next).filter(w => w !== ".");
      rewrites.push({ marker: path.join(home, M.MARKER), workspaces: rel });
      try { act.marker(home, rel); log(`rewrote the folders in ${path.join(home, M.MARKER)}`); }
      catch (err) { log(`could not rewrite ${path.join(home, M.MARKER)}: ${/** @type {Error} */ (err).message}`); }
    }
    // The cache rows: the home, and the home and folders inside the stored spec.
    /** @type {Array<{ slug: string, home: string, spec: string }>} */
    const changed = [];
    for (const r of rows) {
      let spec = null;
      try { spec = JSON.parse(String(r.spec)); } catch {}
      if (spec && typeof spec === "object") {
        if (typeof spec.home === "string") spec.home = remap(spec.home);
        if (Array.isArray(spec.workspaces)) spec.workspaces = remapAll(spec.workspaces);
      }
      const home = remap(String(r.home));
      const text = spec ? JSON.stringify(spec) : String(r.spec);
      if (home !== String(r.home) || text !== String(r.spec)) changed.push({ slug: String(r.slug), home, spec: text });
    }
    for (const c of changed) rewrites.push({ row: c.slug, home: c.home, spec: c.spec });
    if (changed.length) act.rows(changed);
  }

  act.record(out);
  log(`projects moved: ${out.moved.length}, skipped: ${out.skipped.length}; recorded in ${record}`);
  act.emit("projects.moved", { from: out.from, to: out.to, moved: out.moved, skipped: out.skipped, at: out.at });
  return { ...out, rewrites };
}
