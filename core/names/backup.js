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
import { seal, open as unseal, checkPassphrase, inspect } from "./seal.js";
// Re-exported so a caller outside core/names (up.js) needs only this file's own frozen boundary
// entry (test/boundaries.test.js), not a second one for seal.js.
export { inspect };

/** What goes in a backup, in order. Everything else under the root stays out. */
export const INCLUDE = ["config.json", "hub.json", "vyre.db", "vault", "watchers", "modules", "certs", "names"];

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
function copyTree(from, to) {
  fs.cpSync(from, to, {
    recursive: true, preserveTimestamps: true,
    filter: src => { const st = fs.lstatSync(src); return st.isFile() || st.isDirectory(); },
  });
}

/**
 * Write a backup of `root` to `file` (sealed under a passphrase, mode 0600. R8: never plain).
 * @param {{ root?: string, file: string, db?: import("node:sqlite").DatabaseSync, passphrase: string,
 *   includeProviderLogins?: boolean }} o
 * @returns {Promise<{ file: string, bytes: number, included: string[], excludedLogins: string[] }>}
 */
export async function backup({ root = config.home(), file, db, passphrase, includeProviderLogins = false }) {
  if (!file) throw new Error("backup needs a file to write");
  checkPassphrase(passphrase);
  // VYRE_TMPDIR moves the staging folder (the tests point it at their own scratch folder).
  const staging = fs.mkdtempSync(path.join(process.env.VYRE_TMPDIR || os.tmpdir(), "vyre-backup-"));
  const target = path.resolve(file);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  // Outside staging: tar reads staging's own contents, and a plain-tar output file sitting
  // inside the folder being tarred would try to include itself mid-write.
  // In its own 0700 folder, and created 0600 before tar writes into it: the archive is the whole
  // bundle in the clear, and must never sit at the process umask beside the destination.
  const plainDir = fs.mkdtempSync(path.join(process.env.VYRE_TMPDIR || os.tmpdir(), "vyre-backup-plain-"));
  const plain = path.join(plainDir, "backup.tar.gz");
  fs.closeSync(fs.openSync(plain, "wx", 0o600));
  let excludedLogins = [];
  try {
    const included = [];
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
      else if (st.isDirectory()) copyTree(src, path.join(staging, name));
      else continue;
      included.push(name);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await run(["tar", "-czf", plain, "-C", staging, "."]);
    const sealed = seal(fs.readFileSync(plain), passphrase);
    // Created 0600 before the sealed bytes land, so the file is never readable, sealed or not, for a moment.
    fs.closeSync(fs.openSync(tmp, "wx", 0o600));
    fs.writeFileSync(tmp, sealed);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
    return { file: target, bytes: fs.statSync(target).size, included, excludedLogins };
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(plainDir, { recursive: true, force: true });
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
 * @param {{ root?: string, file: string, passphrase: string, force?: boolean,
 *   alive?: (o: { pid: number, socket: string }) => boolean | Promise<boolean> }} o
 * @returns {Promise<{ restored: string[] }>}
 */
export async function restore({ root = config.home(), file, passphrase, force = false, alive = defaultAlive }) {
  const p = config.paths(root);
  let pid = 0;
  try { pid = Number(fs.readFileSync(p.pid, "utf8").trim()) || 0; } catch {}
  if ((pid || fs.existsSync(p.socket)) && await alive({ pid, socket: p.socket })) {
    throw new Error("vyred is running; stop it (vyre down, or systemctl stop vyre.service) before restoring");
  }
  if (fs.existsSync(p.db) && !force) throw new Error(`${p.db} already exists; pass force to replace it`);

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
