// @ts-check
// Which session a call comes from, for a Claude Code session vyred did not start as an agent: a
// terminal `claude`, the assistant at the desk, a headless thread started from a surface.
//
// Claude Code gives an MCP server no session id it documents, and the one in its env is fixed at
// spawn, so it is stale after /clear. The SessionStart hook is told the session id on stdin every
// time it changes (startup, resume, clear, compact), and the hook and the MCP server are both
// direct children of the same `claude` process. So:
//
//   SessionStart hook --threads.bind {session, pid: claude's pid}--> vyred keeps sha256(key)
//                     <-- {key} -- written to <home>/sessions/<pid>.json (0600)
//   MCP server reads <home>/sessions/<its parent pid>.json and sends x-vyre-session + key
//   vyred: the key matches, and that claude process is still alive --> run(input, { thread })
//
// Tamper-evident, not tamper-proof: a claim vyred cannot check is refused, not ignored. The
// pid must be a live `claude` process (or a live headless child of this Switchboard) when the
// session is bound, and a session bound to one live process cannot be bound by another. What
// it does not stop is a process of the same user reading another session's key file; nothing
// under one user account can. Human-only actions need presence proof on top (ADR 0004).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SESSIONS_MIGRATION = `CREATE TABLE threads_binds (session TEXT PRIMARY KEY, key_hash TEXT NOT NULL, pid INTEGER NOT NULL, at INTEGER NOT NULL);`;

const hash = /** @param {string} k */ k => crypto.createHash("sha256").update(k).digest("hex");

/** @param {number} pid */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
}

/** Is this pid a running `claude`? By the name it was started as, which is what `ps` shows. @param {number} pid */
export function isClaude(pid) {
  try { return path.basename(execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim()) === "claude"; }
  catch { return false; }
}

export class Sessions {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ children: () => number[], isClaude?: (pid: number) => boolean, alive?: (pid: number) => boolean }} o
   */
  constructor(db, o) {
    this.db = db;
    this.children = o.children;
    this.isClaude = o.isClaude || isClaude;
    this.alive = o.alive || alive;
  }

  /**
   * Bind a session to the claude process it runs in, and return a new key for it. Binding again
   * from the same process (a /clear keeps the process, a new id comes) replaces the key.
   * @param {string} session @param {number} pid
   */
  bind(session, pid) {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(session)) throw new Error("not a session id");
    if (!this.alive(pid) || !(this.children().includes(pid) || this.isClaude(pid))) throw new Error(`process ${pid} is not a running claude`);
    const had = /** @type {any} */ (this.db.prepare("SELECT pid FROM threads_binds WHERE session = ?").get(session));
    if (had && Number(had.pid) !== pid && this.alive(Number(had.pid))) throw new Error(`session ${session.slice(0, 8)} is bound to another running process`);
    const key = crypto.randomBytes(24).toString("base64url");
    this.db.prepare(`INSERT INTO threads_binds (session, key_hash, pid, at) VALUES (?,?,?,?)
      ON CONFLICT(session) DO UPDATE SET key_hash = excluded.key_hash, pid = excluded.pid, at = excluded.at`).run(session, hash(key), pid, Date.now());
    // Sessions whose process is gone are forgotten on the way.
    for (const r of /** @type {any[]} */ (this.db.prepare("SELECT session, pid FROM threads_binds").all())) {
      if (!this.alive(Number(r.pid))) this.db.prepare("DELETE FROM threads_binds WHERE session = ?").run(r.session);
    }
    return { session, key };
  }

  /** The process a session is bound to, or null. @param {string} session */
  boundPid(session) {
    const r = /** @type {any} */ (this.db.prepare("SELECT pid FROM threads_binds WHERE session = ?").get(String(session)));
    return r ? Number(r.pid) : null;
  }

  /** The session, if this key is its key and its process still runs; else null. @param {string} session @param {string} key */
  vouch(session, key) {
    const r = /** @type {any} */ (this.db.prepare("SELECT key_hash, pid FROM threads_binds WHERE session = ?").get(String(session)));
    if (!r || !key) return null;
    const a = Buffer.from(String(r.key_hash)), b = Buffer.from(hash(String(key)));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return this.alive(Number(r.pid)) ? String(session) : null;
  }
}

/**
 * The hook's side: keep a session's key where the MCP server of the same claude process finds it,
 * readable by this user only, and drop the files of processes that are gone.
 * @param {string} dir <home>/sessions @param {number} pid claude's pid @param {{ session: string, key: string }} bound
 */
export function writeKey(dir, pid, bound) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${pid}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ session: bound.session, key: bound.key }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(f);
    if (m && !alive(Number(m[1]))) try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
}

/** The MCP server's side: the session its claude process is in now, or null. @param {string} dir @param {number} pid */
export function readKey(dir, pid) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), "utf8"));
    return v && typeof v.session === "string" && typeof v.key === "string" ? { id: v.session, key: v.key } : null;
  } catch { return null; }
}
