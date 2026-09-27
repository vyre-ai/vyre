// @ts-check
// import/scan: what Claude Code sessions this device holds, without reading what was said.
//
// For each folder: its session files (*.jsonl), their sizes and times, and the folder each session
// ran in, read from the first lines of the file (Claude Code writes `cwd` on its first entries).
// Nothing else of a session is read here, and nothing leaves the device (docs/design/import.md).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** How much of a session's start is read to find its folder. */
export const HEAD_BYTES = 16 * 1024;
/** How deep a folder the person adds is walked, and what is never walked into. */
const DEPTH = 4;
const SKIP_DIRS = new Set(["node_modules", ".git", "subagents"]);

/** The folder a session ran in: the first `cwd` in its first lines, or null. @param {string} file */
export function cwdOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try { const j = JSON.parse(line); if (typeof j.cwd === "string" && j.cwd) return j.cwd; } catch { /* a line cut at HEAD_BYTES */ }
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * The session files under a folder: a Claude Code projects folder (one folder per project, its
 * sessions directly inside), or any folder, walked a few levels down.
 * @param {string} root
 * @returns {{ file: string, id: string, bytes: number, mtime: number }[]}
 */
export function sessionFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, depth + 1); continue; }
      // Symlinks are never followed: a link could point anywhere on the disk.
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      try { const st = fs.statSync(p); out.push({ file: p, id: e.name.slice(0, -6), bytes: st.size, mtime: st.mtimeMs }); } catch { /* gone meanwhile */ }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** Why a folder's sessions are not suggested for import, or null. */
export function notSuggested(cwd, { quick = null, ask = null, isDev = () => false } = {}) {
  if (!cwd) return "the folder it ran in is unknown";
  if (quick && (cwd === quick || cwd.startsWith(quick + path.sep))) return "Vyre's own quick sessions";
  if (ask && (cwd === ask || cwd.startsWith(ask + path.sep))) return "the Capsule's own questions";
  if (isDev(cwd)) return "work on Vyre itself";
  if (/^\/(?:tmp|private\/tmp|var\/folders)\//.test(cwd)) return "a temporary folder";
  return null;
}

/**
 * Sources, each with its sessions grouped by the folder they ran in.
 * @param {{ path: string, kind: "claude"|"archive"|"folder" }[]} roots
 * @param {{ projectOf?: (cwd: string) => { slug: string, name: string }|null, quick?: string|null, ask?: string|null, isDev?: (cwd: string) => boolean }} [o]
 */
export function scan(roots, o = {}) {
  const sources = [];
  /** @type {Map<string, { file: string, id: string, bytes: number, mtime: number, cwd: string|null, source: string }>} */
  const files = new Map();
  for (const r of roots) {
    const list = sessionFiles(r.path);
    const id = "src_" + crypto.createHash("sha256").update(path.resolve(r.path)).digest("hex").slice(0, 10);
    /** @type {Map<string, any>} */
    const byCwd = new Map();
    let bytes = 0, from = Infinity, to = 0;
    for (const f of list) {
      // The same session in two folders (an archive copy): counted once, where it was found first.
      if (files.has(f.id)) continue;
      const cwd = cwdOf(f.file);
      files.set(f.id, { ...f, cwd, source: id });
      bytes += f.bytes; from = Math.min(from, f.mtime); to = Math.max(to, f.mtime);
      const k = cwd || "";
      const g = byCwd.get(k) || { cwd: cwd || null, sessions: 0, bytes: 0, from: Infinity, to: 0 };
      g.sessions++; g.bytes += f.bytes; g.from = Math.min(g.from, f.mtime); g.to = Math.max(g.to, f.mtime);
      byCwd.set(k, g);
    }
    const folders = [...byCwd.values()].map(g => {
      const why = notSuggested(g.cwd, o);
      const p = g.cwd && o.projectOf ? o.projectOf(g.cwd) : null;
      return { cwd: g.cwd, sessions: g.sessions, bytes: g.bytes, from: Math.round(g.from), to: Math.round(g.to), ...(p ? { project: p.slug, name: p.name } : {}), suggested: !why, ...(why ? { why } : {}) };
    }).sort((a, b) => b.to - a.to || (String(a.cwd) < String(b.cwd) ? -1 : 1));
    const sessions = folders.reduce((n, f) => n + f.sessions, 0);
    sources.push({ id, path: r.path, kind: r.kind, sessions, bytes, ...(sessions ? { from: Math.round(from), to: Math.round(to) } : {}), folders });
  }
  return { sources, files };
}
