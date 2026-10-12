// @ts-check
// One group per project (rc.3, team/0.3.4/PROJECT-GROUPS.md). A team server runs every member's session as that member's own uid; what a session may reach under /work is decided by the groups the
// spawner gives it. This file is the spawner's side: the table that maps a project id to a group number from a reserved range (never reused), the checks on a folder given to a project, and the
// pass that hands an existing folder to its group. The spawner (root, no file capability) never touches the files itself: each pass runs as the uid that owns them (regroup.js).

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The reserved range: 4096 projects per server. Account gids are their uids (2000 to 2063), so the ranges never meet. */
export const GID_MIN = 10000;
export const GID_MAX = 14095;
/** A project id is a short name; it is a key in the table and never a path. */
export const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
export const MAX_PER_SPAWN = 64;
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "regroup.js");

/** @param {string} message @param {string} [code] */
const refusal = (message, code = "refused") => Object.assign(new Error(message), { code });

/** @param {string} a @param {string} b is `a` the folder `b` or inside it */
const inside = (a, b) => a === b || a.startsWith(b + path.sep);

/**
 * @typedef {{ gid: number, paths: Record<string, number> }} Entry  paths: each folder handed to the group, with the time it was done
 * @typedef {{ v: 1, next: number, projects: Record<string, Entry> }} Table
 */

/**
 * Read the table. A file that is there and cannot be read is an error, never an empty table: starting over would give an old group number to a new project and open one project's folder to another.
 * @param {string} file @param {number} min @param {number} max @returns {Table}
 */
export function readTable(file, min, max) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return { v: 1, next: min, projects: {} };
    throw refusal(`the project group table ${file} cannot be read (${/** @type {Error} */ (e).message}); it was left as it is. Restore it from a backup: making a new one would reuse group numbers and open one project's folder to another`, "table_unreadable");
  }
  /** @type {any} */ let t;
  try { t = JSON.parse(text); } catch { throw refusal(`the project group table ${file} is not valid JSON; it was left as it is. Restore it from a backup: making a new one would reuse group numbers and open one project's folder to another`, "table_unreadable"); }
  const bad = (/** @type {string} */ why) => refusal(`the project group table ${file} is damaged (${why}); it was left as it is. Restore it from a backup`, "table_unreadable");
  if (!t || t.v !== 1 || !t.projects || typeof t.projects !== "object" || !Number.isInteger(t.next)) throw bad("not the expected shape");
  const seen = new Set();
  let top = min - 1;
  for (const [id, e] of Object.entries(t.projects)) {
    const g = /** @type {any} */ (e) && /** @type {any} */ (e).gid;
    if (!ID_RE.test(id) || !Number.isInteger(g) || g < min || g > max) throw bad(`project ${id} has a group outside ${min} to ${max}`);
    if (seen.has(g)) throw bad(`group ${g} is given to two projects`);
    seen.add(g); top = Math.max(top, g);
    if (!/** @type {any} */ (e).paths || typeof /** @type {any} */ (e).paths !== "object") throw bad(`project ${id} has no folders list`);
  }
  if (t.next <= top) throw bad("the next group number is not above the ones given");
  return t;
}

/** Write the table: a temporary file in the same folder, then renamed over it. Root-only (0600). @param {string} file @param {Table} t */
export function writeTable(file, t) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The project groups of one spawner.
 * @param {{ file: string, work: string, containers?: string[], min?: number, max?: number,
 *   vyre: { uid: number, gid: number }, groups?: number[], owners: (uid: number) => boolean,
 *   node?: string, timeoutMs?: number, log?: (m: string) => void,
 *   regroup?: (folder: string, gid: number) => Promise<void>, verify?: (folder: string) => Promise<void> }} o
 *   containers: folders that hold project folders (/work/projects): never a project themselves. groups: extra groups every pass holds (the old shared group, so a folder not yet moved is still entered). owners: may a pass run as this uid (Vyre, the box agent, an account).
 *   regroup, verify: replace the real pass and the real rules check (a test with no root).
 */
export function projectGroups(o) {
  const min = o.min ?? GID_MIN, max = o.max ?? GID_MAX, work = path.resolve(o.work);
  const log = o.log || (() => {});
  /** @type {Table | null} */ let table = null;
  const load = () => table || (table = readTable(o.file, min, max));
  let chain = Promise.resolve();
  /** one at a time: a pass walks a whole folder, and two on one project must not race @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = fn => { const r = chain.then(fn, fn); chain = r.then(() => {}, () => {}); return r; };

  /** One pass as `uid`. @returns {Promise<{ fixed: number, others: number[] }>} */
  const pass = (uid, /** @type {"check"|"verify"|null} */ mode, /** @type {string} */ folder, /** @type {number} */ gid) => new Promise((resolve, reject) => {
    const args = [...(mode ? [mode] : []), folder, String(gid), String(o.vyre.uid), work];
    const groups = [...new Set([...(o.groups || []), gid])];
    execFile("/usr/bin/setpriv", [`--reuid=${uid}`, `--regid=${uid === o.vyre.uid ? o.vyre.gid : uid}`, `--groups=${groups.join(",")}`, "--inh-caps=-all", "--", o.node || process.execPath, SCRIPT, ...args],
      { timeout: o.timeoutMs ?? 15 * 60_000, killSignal: "SIGKILL", maxBuffer: 1 << 20, env: { PATH: "/usr/bin:/bin" } }, (e, out, err) => {
        if (e) { const first = String(err || "").split("\n")[0].trim(); return reject(refusal(first || `the pass as uid ${uid} failed (${/** @type {Error} */ (e).message})`, "pass_failed")); }
        try { resolve(JSON.parse(String(out).trim().split("\n").pop() || "{}")); } catch { reject(refusal("the group pass said nothing readable", "pass_failed")); }
      });
  });

  /** The rules on a real folder, as Vyre's user, before a group number is spent on it. @param {string} folder */
  const verify = async folder => { await pass(o.vyre.uid, "verify", folder, GID_MIN); };

  /** The real pass: Vyre's own files first (with the rules check), then each other owner's. @param {string} folder @param {number} gid */
  async function regroup(folder, gid) {
    const first = await pass(o.vyre.uid, "check", folder, gid);
    const done = new Set([o.vyre.uid]);
    for (let queue = [...(first.others || [])]; queue.length;) {
      const uid = /** @type {number} */ (queue.shift());
      if (done.has(uid)) continue;
      done.add(uid);
      if (!o.owners(uid)) { log(`spawner: files of uid ${uid} in ${folder} were left as they are (not an account or the box agent)`); continue; }
      const r = await pass(uid, null, folder, gid);
      for (const u of r.others || []) if (!done.has(u)) queue.push(u);
    }
  }

  /**
   * Allocate or find a project's group and hand the folder to it (once per folder; `force` runs it again).
   * @param {unknown} project @param {unknown} home @param {{ force?: boolean }} [opt]
   * @returns {Promise<{ project: string, gid: number, home: string, migrated: boolean }>}
   */
  const ensure = (project, home, opt = {}) => serial(async () => {
    if (typeof project !== "string" || !ID_RE.test(project)) throw refusal("a project id is letters, digits, dot, dash and underscore, up to 128 characters (the project's short name)");
    if (typeof home !== "string" || !path.isAbsolute(home) || home.includes("\0") || home.length > 1024 || path.resolve(home) !== home) throw refusal(`the folder must be an absolute path with no .. or trailing slash (got ${JSON.stringify(String(home).slice(0, 80))})`);
    if (home === work) throw refusal(`${work} itself cannot be a project folder; give the project's own folder inside it`);
    for (const c of o.containers || []) if (inside(c, home)) throw refusal(`${home} holds project folders; give the project's own folder inside it`);
    if (!inside(home, work)) throw refusal(`${home} is outside ${work}; project folders live under ${work}`);
    const t = load();
    for (const [id, e] of Object.entries(t.projects)) {
      if (id === project) continue;
      for (const p of Object.keys(e.paths)) if (inside(home, p) || inside(p, home)) throw refusal(`${home} overlaps ${p}, which belongs to another project (${id}); one folder belongs to one project, so give this project a folder of its own`);
    }
    let e = t.projects[project];
    if (!(e && e.paths[home]) || opt.force) await (o.verify || (o.regroup ? async () => {} : verify))(home);
    if (!e) {
      if (t.next > max) throw refusal(`this server has used all ${max - min + 1} project groups (${min} to ${max}) and cannot make one for ${project}; group numbers are never reused, so a larger range (VYRE_PROJECT_GID_MAX) or a new server is needed`, "range_full");
      e = { gid: t.next, paths: {} };
      t.projects[project] = e; t.next++;
      writeTable(o.file, t);   // before anything uses the number: a crash after this wastes one, it never reuses one
    }
    if (e.paths[home] && !opt.force) return { project, gid: e.gid, home, migrated: false };
    await (o.regroup || regroup)(home, e.gid);
    e.paths[home] = Date.now();
    writeTable(o.file, t);
    log(`spawner: ${home} is now group ${e.gid} (project ${project})`);
    return { project, gid: e.gid, home, migrated: true };
  });

  return {
    ensure,
    /** The groups for the project ids a spawn names; an id the table does not know is left out. @param {unknown} ids @returns {number[]} */
    gids(ids) {
      if (!Array.isArray(ids)) return [];
      const t = load();
      return [...new Set(ids.map(i => (typeof i === "string" && t.projects[i] ? t.projects[i].gid : 0)).filter(Boolean))];
    },
    /** Every group in the range, for vyred and the box agent to join at start. @returns {number[]} */
    range() { const a = []; for (let g = min; g <= max; g++) a.push(g); return a; },
    /** @returns {{ min: number, max: number, used: number }} */
    stats() { return { min, max, used: Object.keys(load().projects).length }; },
  };
}

/**
 * The work folder as the project groups need it, done at every start as Vyre's user (no capability): /work belongs to the shared group at 2711 (any uid passes through it to a folder it knows; only Vyre and the
 * shared group list it, so a member's session cannot find the other projects), and whatever sits directly in it, and each project folder in /work/projects, has no "other" bits until its project group is
 * given, whatever mode an older volume left it in. Only the folders themselves, never what is inside; links are left alone.
 * @param {{ work: string, shared: number, asVyre: (...argv: string[]) => void, log?: (m: string) => void }} o @returns {string[]} the loose files named in the upgrade notice
 */
export function prepareWork(o) {
  const log = o.log || (() => {});
  try {
    const st = fs.statSync(o.work);
    if (st.gid !== o.shared) { log(`spawner: giving ${o.work} to group ${o.shared}`); o.asVyre("chgrp", String(o.shared), o.work); }
    if ((fs.statSync(o.work).mode & 0o7777) !== 0o2711) { log(`spawner: ${o.work} is now 2711 (passed through, not listed)`); o.asVyre("chmod", "2711", o.work); }
    const held = path.join(o.work, "projects");
    o.asVyre("find", o.work, "-mindepth", "1", "-maxdepth", "1", "!", "-type", "l", "!", "-path", held, "-exec", "chmod", "o-rwx", "{}", "+");
    // the folder that holds the projects is passed through and never listed: others get x only
    if (fs.existsSync(held) && !fs.lstatSync(held).isSymbolicLink()) o.asVyre("chmod", "o=x", held);
    if (fs.existsSync(held)) o.asVyre("find", held, "-mindepth", "1", "-maxdepth", "1", "!", "-type", "l", "-exec", "chmod", "o-rwx", "{}", "+");
    // Upgrade notice: what sits loose directly in /work was the shared group's, which no session holds any more; it is vyred's alone now. Said once per start, never left silently unreadable.
    const loose = fs.readdirSync(o.work, { withFileTypes: true }).filter(e => !e.isSymbolicLink() && e.name !== "projects" && e.isFile()).map(e => e.name);
    if (loose.length) log(`spawner: ${loose.length} loose file(s) directly in ${o.work} are reachable by vyred only now (${loose.slice(0, 20).join(", ")}${loose.length > 20 ? ", ..." : ""}); move what a session needs into its project's folder`);
    return loose;
  } catch (e) { log(`spawner: ${o.work} is not set up for project groups: ${/** @type {Error} */ (e).message}`); return []; }
}
