// @ts-check
// backup — one file that holds everything a box needs to come back: settings, the store, the
// vault, watchers, installed modules, certificates and names.
//
// The store is copied with VACUUM INTO, not by copying vyre.db: vyred may be writing, and a raw
// copy of a WAL database mid-write is not a database. Models and logs are left out (models are
// re-downloaded, logs are not worth keeping), as are the socket and pid file, which only mean
// something to a running vyred.
//
// PLAN.md R8 (plans/launch.md's Review response, BLOCKER 3): the file this writes is always
// sealed under a passphrase (core/names/seal.js), never plain. There is no unencrypted option.
// Provider sign-ins (Claude, Codex, Gemini... whatever core/sessions/config.js's CREDENTIALS
// names) are left OUT of the vault items carried by default, since they are re-made on restore
// by signing in again, not carried; `includeProviderLogins: true` opts back in for a person who
// wants a truly identical copy. The Tailscale node key is never in here at all: it lives in the
// tailscale container's own volume, outside `config.home()` entirely (box/compose.yml), so this
// module never has a chance to include it.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as config from "../config/index.js";
import zlib from "node:zlib";
import { seal, open as unseal, checkPassphrase, inspect as inspectV1, isSealed } from "./seal.js";
import { SealWriter, readRecords, scanPartial, isStream, inspectStream, CHUNK } from "./sealstream.js";
import { within } from "../../lib/within.js";
// Re-exported so a caller outside core/names (up.js) needs only this file's own frozen boundary
// entry (test/boundaries.test.js), not a second one for seal.js. Reads either format's header.
/** @param {Buffer} buf the file's first bytes (or all of a v1 file) */
export function inspect(buf) {
  if (isStream(buf)) { const { header } = inspectStream(buf); return { header: { ...header, bytes: null }, bodyStart: 0 }; }
  return inspectV1(buf);
}
export { isSealed, isStream };

/** What goes in a backup, in order. Everything else under the root stays out. */
export const INCLUDE = ["config.json", "hub.json", "vyre.db", "vault", "watchers", "modules", "certs", "names", "data"];

/**
 * Files under `data` that mean something only to a running process and so stay out: the artifacts
 * share server's own state file (its pid and port). Everything else under data is the person's,
 * artifacts and their versions included (PLAN.md AR8).
 */
const DATA_SKIP = new Set([".server.json"]);

/**
 * Vault item names a provider sign-in lives under. Kept as a plain local constant, not an
 * import of core/sessions/config.js's own CREDENTIALS map: test/boundaries.test.js freezes
 * core/names' allowed cross-part edges, and core/names -> core/sessions is not one of them (a
 * new edge needs the lead's OK). Flagged in CHAT.md: a provider sign-in's vault item name added
 * in core/sessions/config.js's CREDENTIALS needs adding here too, by hand, until there is a
 * shared kernel-level list either side can import.
 */
const PROVIDER_LOGIN_NAMES = () => ["claude-setup-token", "anthropic-api-key"];

/** Run a command in argv form and collect its output; reject on a non-zero exit. */
function run(argv, opts = {}) {
  return new Promise((resolve, reject) => {
    // COPYFILE_DISABLE stops macOS tar adding ._ files for extended attributes.
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" }, ...opts });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`${argv[0]} exited ${code}: ${stderr.trim()}`)));
  });
}

/** Copy a folder, keeping only files and folders: sockets mean nothing later, and restore refuses links. */
function copyTree(from, to, skip = /** @type {Set<string> | null} */ (null)) {
  fs.cpSync(from, to, {
    recursive: true, preserveTimestamps: true,
    filter: src => { if (skip && skip.has(path.basename(src))) return false; const st = fs.lstatSync(src); return st.isFile() || st.isDirectory(); },
  });
}

/** Files and folders under a project root, links left out, in a fixed order (a resume regenerates the same stream). */
export function walkWork(root) {
  const list = [], out = { files: 0, bytes: 0, links: 0, unreadable: 0 };
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { out.unreadable++; return; }
    ents.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const e of ents) {
      // A newline in a name cannot ride a tar file list; such a file is counted, not carried.
      if (e.name.includes("\n") || e.name.includes("\0")) { out.unreadable++; continue; }
      const r = rel ? `${rel}/${e.name}` : e.name, p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { out.links++; continue; }
      if (e.isDirectory()) { list.push(r); walk(p, r); continue; }
      if (!e.isFile()) continue;
      try { out.bytes += fs.lstatSync(p).size; out.files++; list.push(r); } catch { out.unreadable++; }
    }
  };
  walk(root, "");
  return { list, ...out };
}

/** Bytes under a path, links not followed. */
function sizeOf(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let n = 0;
  for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e));
  return n;
}

/**
 * What an export would hold, to show before it starts: the box's own data and each project folder's
 * size. @param {{ root?: string, workRoots?: string[] }} [o]
 */
export function estimate({ root = config.home(), workRoots = [] } = {}) {
  let state = 0;
  for (const name of INCLUDE) state += sizeOf(path.join(root, name));
  const work = workRoots.map(r => { const w = walkWork(r); return { path: r, files: w.files, bytes: w.bytes, links: w.links }; });
  return { state, work, total: state + work.reduce((n, w) => n + w.bytes, 0) };
}

/** tar's output as a gzip stream we can iterate. Exit 1 (a file changed or vanished while read) is a warning. */
/** How long tar may take to exit after its output has ended. */
const TAR_EXIT_MS = 30_000;

export async function* tarGz(args, warnings, { exitMs = TAR_EXIT_MS } = {}) {
  const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  let err = "";
  child.stderr.on("data", d => { if (err.length < 4096) err += d; });
  const closed = new Promise(res => child.on("close", code => res(code)));
  const failed = new Promise((_, rej) => child.on("error", rej));
  failed.catch(() => {});
  const gz = child.stdout.pipe(zlib.createGzip({ level: 6 }));
  // tar is only stopped when the reader gives up early. Once its output has ended it is about to exit
  // on its own, but its exit code may not be in yet: killing it then turns a clean 0 into "exited null",
  // which a busy machine (a runner at load 30) hit now and then (30 Sep).
  let drained = false;
  try { for await (const part of gz) yield /** @type {Buffer} */ (part); drained = true; }
  finally { if (!drained && !child.killed && child.exitCode === null) child.kill(); }
  // Its output has ended, so it should exit now; one that never does (a hung process, a stuck mount) is killed
  // with a plain error, so a backup is never held open by it.
  const code = await within(Promise.race([closed, failed]), exitMs, "hung");
  if (code === "hung") { try { child.kill("SIGKILL"); } catch {} throw new Error(`tar did not exit ${exitMs >= 1000 ? `${Math.round(exitMs / 1000)} seconds` : `${exitMs} ms`} after its output ended; it was stopped`); }
  if (code === 1) warnings.push("some files changed while they were being read");
  else if (code !== 0) throw new Error(`tar exited ${code}: ${err.trim()}`);
}

/** Wrap a stream so its first `n` bytes must hash to `sha256` (a resume): throws "changed" if not. */
async function* verifyPrefix(source, n, sha256) {
  if (n === 0) { yield* source; return; }
  const h = crypto.createHash("sha256");
  let seen = 0, checked = false;
  const changed = () => Object.assign(new Error("the project files changed since the unfinished export"), { changed: true });
  for await (const part of source) {
    if (!checked) {
      h.update(part.subarray(0, Math.min(part.length, n - seen)));
      seen += Math.min(part.length, n - seen);
      // Checked before the part holding the boundary is passed on, so nothing new is written first.
      if (seen === n) { if (h.digest("hex") !== sha256) throw changed(); checked = true; }
    }
    yield part;
  }
  if (!checked) throw changed();
}

/**
 * Write a backup of `root` to `file`: one sealed file (mode 0600, R8: never plain) holding the box's
 * data and, unless skipped, each project folder in `work.roots`. It is written as a stream, so no
 * archive is ever whole in memory or in the clear on disk. An unfinished export (`<file>.partial`)
 * is picked up where it stopped when the same passphrase opens it and the project files are unchanged.
 * @param {{ root?: string, file: string, db?: import("node:sqlite").DatabaseSync, passphrase: string,
 *   includeProviderLogins?: boolean, work?: { roots?: string[], skip?: boolean, transcripts?: string[], skipTranscripts?: boolean },
 *   onProgress?: (p: { phase: string, done: number, total: number }) => void,
 *   sealParams?: { N: number, r: number, p: number }, chunk?: number }} o
 * @returns {Promise<{ file: string, bytes: number, included: string[], excludedLogins: string[],
 *   projects: { name: string, kind: string, files: number, bytes: number }[], resumed: boolean, warnings: string[] }>}
 */
export async function backup({ root = config.home(), file, db, passphrase, includeProviderLogins = false, work = {}, onProgress, sealParams, chunk = CHUNK }) {
  if (!file) throw new Error("backup needs a file to write");
  checkPassphrase(passphrase);
  const isDir = r => { try { return fs.statSync(r).isDirectory(); } catch { return false; } };
  // Project folders, then the folders holding the person's session transcripts (Claude Code's own, and the synced copies): the
  // same tar segments, told apart in the manifest so a restore can leave either out.
  const roots = [...(work.skip ? [] : (work.roots || []).filter(isDir)).map(r => ({ path: r, kind: "project" })),
    ...(work.skipTranscripts ? [] : (work.transcripts || []).filter(isDir)).map(r => ({ path: r, kind: "transcripts" }))];
  // VYRE_TMPDIR moves the staging folder (the tests point it at their own scratch folder).
  const staging = fs.mkdtempSync(path.join(process.env.VYRE_TMPDIR || os.tmpdir(), "vyre-backup-"));
  const target = path.resolve(file);
  const partial = `${target}.partial`;
  const warnings = [];
  let excludedLogins = [], resumed = false;
  /** @type {SealWriter|null} */ let writer = null;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // What is there to export, listed up front and in a fixed order.
    const walks = roots.map(r => ({ path: r.path, kind: r.kind, name: path.basename(r.path) || "work", ...walkWork(r.path) }));
    const names = new Set();
    for (const w of walks) { let n = w.name, i = 2; while (names.has(n)) n = `${w.name}-${i++}`; w.name = n; names.add(n); }
    const total = walks.reduce((n, w) => n + w.bytes, 0);
    let done = 0;
    const tick = phase => onProgress?.({ phase, done, total });

    // Resume: the same passphrase must open the unfinished file.
    let scanned = null;
    let pst = null;
    try { pst = fs.lstatSync(partial); } catch { /* none */ }
    // A link or folder where the unfinished file should be is not ours to write through or replace.
    if (pst && !pst.isFile()) throw new Error(`${partial} is not a regular file; move it aside and run this again`);
    if (pst) {
      try { scanned = scanPartial(partial, passphrase); } catch { scanned = null; }
      if (!scanned || scanned.complete || scanned.header.chunk !== chunk) { fs.rmSync(partial, { force: true }); scanned = null; }
    }
    const seg = i => (scanned && scanned.segments[i]) || null;
    const manifest = () => Buffer.from(JSON.stringify({ v: 2, at: Date.now(), projects: walks.map((w, i) => ({ seg: 2 + i, kind: w.kind, name: w.name, path: w.path, files: w.files, bytes: w.bytes, links: w.links })), skippedProjects: Boolean(work.skip), skippedTranscripts: Boolean(work.skipTranscripts) }));

    if (scanned) {
      // Whole segments already in the file stay; a half-written manifest or state is redone, and
      // so is a project segment whose files have changed since.
      const firstOpen = [0, 1, ...walks.map((_, i) => 2 + i)].find(i => !seg(i)?.done);
      const open = scanned.open;
      const keepOpen = open && open.seg >= 2 && firstOpen === open.seg;
      writer = SealWriter.resume(partial, passphrase, keepOpen ? scanned : scanned.openAt);
      resumed = true;
    } else {
      writer = SealWriter.create(partial, passphrase, { params: sealParams, chunk });
    }
    const w = writer;

    const included = [];
    if (!seg(0)?.done) { await w.segment(0, (async function* () { yield manifest(); })()); }

    if (!seg(1)?.done) {
      let excludedIds = [];
      for (const name of INCLUDE) {
        const src = path.join(root, name);
        if (name === "vyre.db") {
          if (!db && !fs.existsSync(src)) continue;
          const out = path.join(staging, "vyre.db");
          // VACUUM INTO takes a string literal, not a parameter. Refuse quotes instead of escaping.
          if (/['"\0]/.test(out)) throw new Error(`temp folder ${staging} has a quote in it; set VYRE_TMPDIR or TMPDIR elsewhere`);
          let own = null;
          if (!db) {
            const { DatabaseSync } = await import("node:sqlite");
            own = new DatabaseSync(src);
          }
          try { (db || own).exec(`VACUUM INTO '${out}'`); } finally { own?.close(); }
          if (!includeProviderLogins) {
            const { DatabaseSync } = await import("node:sqlite");
            const staged = new DatabaseSync(out);
            try {
              const names = PROVIDER_LOGIN_NAMES();
              // Accounts (core/sessions/accounts.js) name any vault item as their sign-in: Codex, Grok,
              // a second Claude. Read the names from the staged copy, so no import across the boundary.
              if (staged.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions_accounts'").get()) {
                for (const r of /** @type {any[]} */ (staged.prepare("SELECT vault_item FROM sessions_accounts WHERE vault_item IS NOT NULL").all())) {
                  if (typeof r.vault_item === "string" && !names.includes(r.vault_item)) names.push(r.vault_item);
                }
              }
              // vault_items may not exist yet (a store older than the vault module, or a test
              // fixture with no vault table at all); nothing to exclude either way.
              const hasTable = staged.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_items'").get();
              if (names.length && hasTable) {
                const rows = /** @type {any[]} */ (staged.prepare(`SELECT id, name FROM vault_items WHERE name IN (${names.map(() => "?").join(",")})`).all(...names));
                excludedIds = rows.map(r => r.id);
                excludedLogins = rows.map(r => r.name);
                // secure_delete zeroes the freed pages, and the VACUUM below rewrites the file, so the
                // excluded value is not left in free space to be read out of the sealed bytes later.
                if (excludedIds.length) staged.exec("PRAGMA secure_delete = ON");
                if (excludedIds.length) staged.prepare(`DELETE FROM vault_items WHERE id IN (${excludedIds.map(() => "?").join(",")})`).run(...excludedIds);
              }
              if (excludedIds.length) staged.exec("VACUUM");
            } finally { staged.close(); }
          }
          included.push(name);
          continue;
        }
        let st;
        try { st = fs.lstatSync(src); } catch { continue; }
        if (name === "vault" && st.isDirectory() && excludedIds.length) {
          copyTree(src, path.join(staging, name));
          for (const id of excludedIds) fs.rmSync(path.join(staging, name, "items", id + ".json"), { force: true });
        } else if (st.isFile()) fs.copyFileSync(src, path.join(staging, name));
        else if (st.isDirectory()) copyTree(src, path.join(staging, name), name === "data" ? DATA_SKIP : null);
        else continue;
        included.push(name);
      }
      tick("data");
      await w.segment(1, tarGz(["-cf", "-", "-C", staging, "."], warnings));
    } else {
      for (const name of INCLUDE) if (fs.existsSync(path.join(root, name))) included.push(name);
    }

    for (let i = 0; i < walks.length; i++) {
      const p = walks[i], n = 2 + i;
      if (seg(n)?.done) { done += p.bytes; continue; }
      const listFile = path.join(staging, `list-${i}`);
      fs.writeFileSync(listFile, p.list.map(x => x + "\0").join(""), { mode: 0o600 });
      const args = ["-cf", "-", "--no-recursion", "--null", "-C", p.path, "-T", listFile];
      const open = scanned?.open;
      const skipBytes = resumed && open && open.seg === n && w.counter === scanned.records ? open.bytes : 0;
      const each = b => { done += b; tick("projects"); };
      try {
        await w.segment(n, verifyPrefix(tarGz(args, warnings), skipBytes, open?.sha256 || ""), { skipBytes, onBytes: each });
      } catch (e) {
        if (!/** @type {any} */ (e).changed) throw e;
        // The files moved on since the unfinished run: that project starts over from its first byte.
        w.rewind(scanned.openAt);
        warnings.push(`${p.name}: changed since the unfinished export, so it was started again`);
        await w.segment(n, tarGz(args, warnings), { onBytes: each });
      }
    }
    w.end();
    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, target);
    return { file: target, bytes: fs.statSync(target).size, included, excludedLogins,
      projects: walks.map(p => ({ name: p.name, kind: p.kind, files: p.files, bytes: p.bytes })), resumed, warnings };
  } catch (e) {
    // The partial file stays: that is what a resume continues from.
    writer?.close();
    throw e;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Is a vyred alive for this root? The pid file first, then whether the socket answers. */
async function defaultAlive({ pid, socket }) {
  // A pid file outlives a killed container, and the one-off container that runs the restore can
  // hand this process the same pid (vyred and the CLI are both pid 7 under docker-init).
  if (pid && pid !== process.pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { if (/** @type {any} */ (e).code === "EPERM") return true; }
  }
  if (!fs.existsSync(socket)) return false;
  return new Promise(resolve => {
    const c = net.connect(socket);
    const done = ok => { c.destroy(); resolve(ok); };
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
    c.setTimeout(1000, () => done(false));
  });
}

/** Every archive entry must be relative, stay inside, and sit under one of the known names. */
export function checkEntries(list) {
  const bad = [];
  for (const raw of list.split("\n").map(s => s.replace(/\r$/, "")).filter(Boolean)) {
    const e = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (raw.startsWith("/") || raw.split("/").includes("..")) { bad.push(raw); continue; }
    if (e === "" || e === ".") continue;
    if (!INCLUDE.includes(e.split("/")[0])) bad.push(raw);
  }
  if (bad.length) throw new Error(`refusing a backup with unsafe entries: ${bad.slice(0, 5).join(", ")}`);
}

/** As refuseLinks, but a top-level file whose name matches `skip` is ours (a staged segment), not the archive's. */
function refuseLinksExcept(dir, skip) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) refuseLinks(p);
    else if (!e.isFile()) throw new Error(`refusing a backup containing a link or special file: ${e.name}`);
  }
}

/** Walk an extracted tree; links could point anywhere once moved into the root, so refuse them. */
function refuseLinks(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) refuseLinks(p);
    else if (!e.isFile()) throw new Error(`refusing a backup containing a link or special file: ${e.name}`);
  }
}

/**
 * Put a v1 (whole-buffer) backup back into `root`.
 * @param {{ root?: string, file: string, passphrase: string, force?: boolean,
 *   alive?: (o: { pid: number, socket: string }) => boolean | Promise<boolean> }} o
 * @returns {Promise<{ restored: string[] }>}
 */
async function restoreV1({ root, file, passphrase }) {
  const sealed = fs.readFileSync(path.resolve(file));
  const plainBytes = unseal(sealed, passphrase);

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Staging inside the root, so each piece moves into place with a rename on the same disk.
  const staging = fs.mkdtempSync(path.join(root, ".restore-"));
  const plainFile = path.join(staging, ".plain.tar.gz");
  try {
    fs.writeFileSync(plainFile, plainBytes);
    checkEntries(String(await run(["tar", "-tzf", plainFile])));
    await run(["tar", "-xzpf", plainFile, "-C", staging]);
    fs.rmSync(plainFile, { force: true });
    refuseLinks(staging);
    const restored = [];
    for (const name of INCLUDE) {
      const src = path.join(staging, name);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(root, name);
      fs.rmSync(dst, { recursive: true, force: true });
      // A WAL left from the old store would be replayed onto the restored one and corrupt it.
      if (name === "vyre.db") for (const x of ["-wal", "-shm"]) fs.rmSync(dst + x, { force: true });
      fs.renameSync(src, dst);
      restored.push(name);
    }
    return { restored };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Move an extracted folder's entries into `dest`, refusing links; existing names need force. */
function moveInto(from, dest) {
  refuseLinks(from);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const to = path.join(dest, name);
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(path.join(from, name), to);
  }
}

/** A verbose tar listing may hold files and folders only: a link or device is refused before extraction. */
function refuseSpecialEntries(verbose) {
  for (const line of String(verbose).split("\n")) {
    if (!line) continue;
    if (!/^[-d]/.test(line)) throw new Error(`refusing a backup containing a link or special file: ${line.replace(/^\S+\s+/, "").slice(0, 80)}`);
  }
}

/** The nearest existing folder at or above `p`. */
function existingAncestor(p) {
  let q = path.resolve(p);
  while (!fs.existsSync(q)) { const up = path.dirname(q); if (up === q) break; q = up; }
  return q;
}

/** Room for `need` bytes where `p` is (or would be), per device, or an error saying how much is missing. */
function checkRoom(needs) {
  /** @type {Map<number, { need: number, at: string }>} */ const byDev = new Map();
  for (const { at, need } of needs) {
    const q = existingAncestor(at);
    const dev = fs.statSync(q).dev;
    const cur = byDev.get(dev) || { need: 0, at: q };
    cur.need += need; byDev.set(dev, cur);
  }
  for (const { need, at } of byDev.values()) {
    const st = fs.statfsSync(at);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < need) throw new Error(`not enough room on the disk holding ${at}: this needs about ${Math.ceil(need / 1048576)} MB and ${Math.floor(free / 1048576)} MB is free`);
  }
}

/**
 * Read a v2 backup's manifest (its first segment) and say where each project folder would go, without
 * changing anything. A folder is put back where it came from only when that is under this box's project
 * folder (or `projectRoots`); anywhere else it must be named with `workTo`.
 * @param {{ file: string, passphrase: string, workTo?: Record<string,string>, skipProjects?: boolean, projectRoots?: string[] }} o
 * @returns {{ at: number, projects: { name: string, kind: string, from: string, to: string, files: number, bytes: number, seg: number }[] }}
 */
export function planRestore({ file, passphrase, workTo, skipProjects = false, skipTranscripts = false, projectRoots = [config.workDir()] }) {
  const parts = [];
  for (const r of readRecords(path.resolve(file), passphrase)) { if (r.seg !== 0) break; parts.push(r.plain); if (r.last) break; }
  let manifest;
  try { manifest = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("this backup has no readable manifest"); }
  const inside = (p, root) => { const rel = path.relative(path.resolve(root), path.resolve(p)); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
  const projects = [];
  for (const pr of (manifest.projects || []).filter(x => (x.kind === "transcripts" ? !skipTranscripts : !skipProjects))) {
    const chosen = workTo && workTo[pr.name];
    if (chosen === undefined && (typeof pr.path !== "string" || !path.isAbsolute(pr.path) || !projectRoots.some(r => inside(pr.path, r)))) {
      throw new Error(`the project files "${pr.name}" came from ${String(pr.path).slice(0, 120)}, which is not this device's project folder; say where they go with --work-to DIR (or skip them with --skip-projects)`);
    }
    projects.push({ name: pr.name, kind: pr.kind === "transcripts" ? "transcripts" : "project", from: pr.path, to: path.resolve(chosen ?? pr.path), files: pr.files, bytes: pr.bytes, seg: pr.seg });
  }
  return { at: manifest.at, projects };
}

/**
 * Put a v2 backup back: every segment is decrypted and checked to its end record before anything on
 * disk changes, then the box's data goes into `root` and each project folder into its own place.
 */
async function restoreV2({ root, file, passphrase, force, workTo, skipProjects, skipTranscripts, projectRoots }) {
  // Where things go is settled, and refused if it is not allowed, before a byte is written.
  const plan = planRestore({ file, passphrase, workTo, skipProjects, skipTranscripts, projectRoots });
  const sealedSize = fs.statSync(path.resolve(file)).size;
  checkRoom([{ at: root, need: Math.ceil(sealedSize * 1.1) + 64 * 1048576 }, ...plan.projects.map(p => ({ at: p.to, need: Math.ceil(p.bytes * 1.05) }))]);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Staging inside the root, so the box's own pieces move into place with a rename on the same disk.
  const staging = fs.mkdtempSync(path.join(root, ".restore-"));
  try {
    /** @type {Map<number, number>} */ const fds = new Map();
    const segFile = n => path.join(staging, `seg-${n}.tar.gz`);
    const wanted = new Set(plan.projects.map(p => p.seg));
    try {
      for (const r of readRecords(path.resolve(file), passphrase)) {
        if (r.seg >= 2 && !wanted.has(r.seg)) continue;
        let fd = fds.get(r.seg);
        if (fd === undefined) { fd = fs.openSync(r.seg === 0 ? path.join(staging, "manifest.json") : segFile(r.seg), "w", 0o600); fds.set(r.seg, fd); }
        fs.writeSync(fd, r.plain);
      }
    } finally { for (const fd of fds.values()) fs.closeSync(fd); }
    if (!fds.has(1)) throw new Error("this backup holds no box data");

    // Everything is checked before anything moves: names, then link and device entries.
    for (const pr of plan.projects) {
      const list = String(await run(["tar", "-tzf", segFile(pr.seg)]));
      const tops = new Set();
      for (const raw of list.split("\n").map(x => x.replace(/\r$/, "")).filter(Boolean)) {
        if (raw.startsWith("/") || raw.split("/").includes("..")) throw new Error(`refusing a backup with unsafe entries: ${raw}`);
        const e = raw.replace(/^\.\//, "").replace(/\/$/, "");
        if (e && e !== ".") tops.add(e.split("/")[0]);
      }
      const clash = [...tops].filter(t => fs.existsSync(path.join(pr.to, t)));
      if (clash.length && !force) throw new Error(`${path.join(pr.to, clash[0])} already exists; pass force to replace it`);
      refuseSpecialEntries(await run(["tar", "-tvzf", segFile(pr.seg)]));
    }
    checkEntries(String(await run(["tar", "-tzf", segFile(1)])));
    refuseSpecialEntries(await run(["tar", "-tvzf", segFile(1)]));

    // The box's own data first, and its links caught right after this tar, before any project is touched.
    await run(["tar", "-xzpf", segFile(1), "-C", staging]);
    fs.rmSync(segFile(1), { force: true });
    fs.rmSync(path.join(staging, "manifest.json"), { force: true });
    refuseLinksExcept(staging, /^seg-\d+\.tar\.gz$/);
    for (const pr of plan.projects) {
      // Inside the destination itself: it may be a mount point, whose parent is not ours to write.
      fs.mkdirSync(pr.to, { recursive: true });
      const tmp = fs.mkdtempSync(path.join(pr.to, ".vyre-restore-"));
      try {
        await run(["tar", "-xzpf", segFile(pr.seg), "-C", tmp]);
        moveInto(tmp, pr.to);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      fs.rmSync(segFile(pr.seg), { force: true });
    }
    const restored = [];
    for (const name of INCLUDE) {
      const src = path.join(staging, name);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(root, name);
      fs.rmSync(dst, { recursive: true, force: true });
      // A WAL left from the old store would be replayed onto the restored one and corrupt it.
      if (name === "vyre.db") for (const x of ["-wal", "-shm"]) fs.rmSync(dst + x, { force: true });
      fs.renameSync(src, dst);
      restored.push(name);
    }
    return { restored, projects: plan.projects.map(p => ({ name: p.name, to: p.to, files: p.files, bytes: p.bytes })) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Put a backup back into `root`. vyred must be stopped, and an existing store is only replaced
 * with force. Reads the current format (a stream, with project files) and the first one.
 * @param {{ root?: string, file: string, passphrase: string, force?: boolean, workTo?: Record<string,string>,
 *   skipProjects?: boolean, projectRoots?: string[], alive?: (o: { pid: number, socket: string }) => boolean | Promise<boolean> }} o
 * @returns {Promise<{ restored: string[], projects: { name: string, to: string, files: number, bytes: number }[] }>}
 */
export async function restore({ root = config.home(), file, passphrase, force = false, workTo, skipProjects = false, skipTranscripts = false, projectRoots, alive = defaultAlive }) {
  const p = config.paths(root);
  let pid = 0;
  try { pid = Number(fs.readFileSync(p.pid, "utf8").trim()) || 0; } catch {}
  if ((pid || fs.existsSync(p.socket)) && await alive({ pid, socket: p.socket })) {
    throw new Error("vyred is running; stop it (vyre down, or systemctl stop vyre.service) before restoring");
  }
  if (fs.existsSync(p.db) && !force) throw new Error(`${p.db} already exists; pass force to replace it`);
  const head = Buffer.alloc(8192);
  const fd = fs.openSync(path.resolve(file), "r");
  let n = 0;
  try { n = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  if (isStream(head.subarray(0, n))) return restoreV2({ root, file, passphrase, force, workTo, skipProjects, skipTranscripts, projectRoots });
  return { ...(await restoreV1({ root, file, passphrase })), projects: [] };
}
