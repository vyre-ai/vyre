// @ts-check
// Path-safe file access for the runner's own sync (reviewer-2 R1, probes Z1 and Z2). The runner runs OUTSIDE the sandbox with the
// member's full rights, and the workspace is where the session writes, so the session can plant a symlink anywhere in it. Nothing
// here follows one: every directory component is checked with lstat, the last component is opened with O_NOFOLLOW, the result must
// be a regular file, and the real path must stay inside the workspace root. Writes go to a temp file in the verified folder and are
// renamed into place (a rename replaces a planted symlink instead of following it).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const NONBLOCK = fs.constants.O_NONBLOCK || 0;
const err = (code, m) => Object.assign(new Error(m), { code });

/** Split a relative path into safe components, refusing "", ".", ".." and absolute parts. @param {string} rel */
export function parts(rel) {
  const p = String(rel).split(/[\\/]+/).filter(Boolean);
  if (!p.length || p.some(x => x === "." || x === ".." || x.includes("\0") || /^[A-Za-z]:$/.test(x))) throw err("unsafe_path", "unsafe path");
  return p;
}

/** The real path of the root, resolved once. @param {string} root */
const realRoot = root => fs.realpathSync(root);

/** Walk the directory components under root with lstat; none may be a symlink. Returns the directory path. @param {string} root @param {string[]} dirs @param {boolean} create */
function safeDir(root, dirs, create) {
  let cur = realRoot(root);
  for (const d of dirs) {
    cur = path.join(cur, d);
    let st = null;
    try { st = fs.lstatSync(cur); } catch { st = null; }
    if (!st) { if (!create) throw err("not_found", "no such folder"); fs.mkdirSync(cur, { mode: 0o700 }); st = fs.lstatSync(cur); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw err("unsafe_path", "a link or a file where a folder should be");
  }
  return cur;
}

const inside = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Read a regular file under root without following links. Returns null for anything that is not a plain file inside root.
 * @param {string} root @param {string} rel @param {number} maxBytes
 * @returns {Buffer|null}
 */
export function readInside(root, rel, maxBytes) {
  let fd = -1;
  try {
    const p = parts(rel);
    const dir = safeDir(root, p.slice(0, -1), false);
    const full = path.join(dir, p[p.length - 1]);
    const l = fs.lstatSync(full);
    if (!l.isFile()) return null;
    fd = fs.openSync(full, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes || st.ino !== l.ino || st.dev !== l.dev) return null;
    // After the open, the path must still lead to the same place inside the root (a swap between the checks and the open).
    if (!inside(fs.realpathSync(full), realRoot(root))) return null;
    // Linux: the descriptor itself says where the file it opened really is. This is race-free, unlike a path check, because a swap
    // after the open cannot change what the descriptor points at (reviewer-2 S-1). macOS has no /proc: there the sandbox's own
    // pause (runner.js) is the only guard, and a helper outside the process group can still race it (an open limit).
    if (process.platform === "linux" && !inside(fs.readlinkSync(`/proc/self/fd/${fd}`), realRoot(root))) return null;
    const buf = Buffer.alloc(st.size);
    let n = 0; while (n < st.size) { const r = fs.readSync(fd, buf, n, st.size - n, n); if (!r) break; n += r; }
    return buf.subarray(0, n);
  } catch { return null; } finally { if (fd >= 0) try { fs.closeSync(fd); } catch {} }
}

/** Every regular file under base/sub (relative to base, "/" separated), never descending into or listing a link; base/sub itself must be a plain folder path. @param {string} base @param {string} sub @returns {string[]} */
export function listInside(base, sub) {
  const out = [];
  const walk = (abs, rel) => {
    let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(abs, e.name), r); else if (e.isFile()) out.push(r);
    }
  };
  try { walk(safeDir(base, parts(sub), false), sub); } catch {}
  return out;
}

/** Write a file under root, creating folders, never through a link. @param {string} root @param {string} rel @param {Buffer} data */
export function writeInside(root, rel, data) {
  const p = parts(rel);
  const dir = safeDir(root, p.slice(0, -1), true);
  const dest = path.join(dir, p[p.length - 1]);
  const tmp = path.join(dir, `.vyre-${crypto.randomBytes(6).toString("hex")}.tmp`);
  try { fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" }); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }   // a full disk leaves no half file
  try { fs.renameSync(tmp, dest); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

/**
 * Is this path in a work folder one that is never carried back from another computer? One structural rule, not a list that grows: any path with a segment that starts with a dot (.claude, .cursor, .github,
 * .husky, .vscode, rc files, whatever tool comes next), and the agent instruction files by name at any depth (CLAUDE.md, AGENTS.md, GEMINI.md, GROK.md and their local forms). Everything else the chat changed
 * comes back. A file an agent wrote there would otherwise run here with this session's authority on the next turn (trust rows 17, 29, 45). One rule for restore and for resume-lent.
 * @param {string} rel
 */
export function plantable(rel) {
  const p = String(rel).split(/[\\/]+/).filter(Boolean).map(x => x.toLowerCase());
  if (p.some(x => x.startsWith("."))) return true;
  return /^(claude|claude\.local|agents|gemini|grok|copilot-instructions)\.md$/.test(p[p.length - 1] || "");
}
