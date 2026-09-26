// @ts-check
// backup — one file that holds everything a box needs to come back: settings, the store, the
// vault, watchers, installed modules, certificates and names.
//
// The store is copied with VACUUM INTO, not by copying vyre.db: vyred may be writing, and a raw
// copy of a WAL database mid-write is not a database. Models and logs are left out (models are
// re-downloaded, logs are not worth keeping), as are the socket and pid file, which only mean
// something to a running vyred.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as config from "../config/index.js";

/** What goes in a backup, in order. Everything else under the root stays out. */
export const INCLUDE = ["config.json", "vyre.db", "vault", "watchers", "modules", "certs", "names"];

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
function copyTree(from, to) {
  fs.cpSync(from, to, {
    recursive: true, preserveTimestamps: true,
    filter: src => { const st = fs.lstatSync(src); return st.isFile() || st.isDirectory(); },
  });
}

/**
 * Write a backup of `root` to `file` (a .tar.gz, mode 0600).
 * @param {{ root?: string, file: string, db?: import("node:sqlite").DatabaseSync }} o
 * @returns {Promise<{ file: string, bytes: number, included: string[] }>}
 */
export async function backup({ root = config.home(), file, db }) {
  if (!file) throw new Error("backup needs a file to write");
  // VYRE_TMPDIR moves the staging folder (the tests point it at their own scratch folder).
  const staging = fs.mkdtempSync(path.join(process.env.VYRE_TMPDIR || os.tmpdir(), "vyre-backup-"));
  const target = path.resolve(file);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const included = [];
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
        included.push(name);
        continue;
      }
      let st;
      try { st = fs.lstatSync(src); } catch { continue; }
      if (st.isFile()) fs.copyFileSync(src, path.join(staging, name));
      else if (st.isDirectory()) copyTree(src, path.join(staging, name));
      else continue;
      included.push(name);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Created 0600 before tar writes into it, so the vault is never readable even for a moment.
    fs.closeSync(fs.openSync(tmp, "wx", 0o600));
    await run(["tar", "-czf", tmp, "-C", staging, "."]);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
    return { file: target, bytes: fs.statSync(target).size, included };
  } finally {
    fs.rmSync(tmp, { force: true });
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

/** Walk an extracted tree; links could point anywhere once moved into the root, so refuse them. */
function refuseLinks(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) refuseLinks(p);
    else if (!e.isFile()) throw new Error(`refusing a backup containing a link or special file: ${e.name}`);
  }
}

/**
 * Put a backup back into `root`. vyred must be stopped, and an existing store is only replaced
 * with force.
 * @param {{ root?: string, file: string, force?: boolean,
 *   alive?: (o: { pid: number, socket: string }) => boolean | Promise<boolean> }} o
 * @returns {Promise<{ restored: string[] }>}
 */
export async function restore({ root = config.home(), file, force = false, alive = defaultAlive }) {
  const p = config.paths(root);
  let pid = 0;
  try { pid = Number(fs.readFileSync(p.pid, "utf8").trim()) || 0; } catch {}
  if ((pid || fs.existsSync(p.socket)) && await alive({ pid, socket: p.socket })) {
    throw new Error("vyred is running; stop it (vyre down, or systemctl stop vyre.service) before restoring");
  }
  if (fs.existsSync(p.db) && !force) throw new Error(`${p.db} already exists; pass force to replace it`);

  checkEntries(String(await run(["tar", "-tzf", path.resolve(file)])));

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Staging inside the root, so each piece moves into place with a rename on the same disk.
  const staging = fs.mkdtempSync(path.join(root, ".restore-"));
  try {
    await run(["tar", "-xzpf", path.resolve(file), "-C", staging]);
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
