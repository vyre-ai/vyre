// @ts-check
// folder-docs: an agent's or a project's Instructions (AGENTS.md and CLAUDE.md) and Context (a context/ folder), read and written in ONE place, over a folder root. The caller says which folder
// (agentDir(id) or a project's home) and who may; this file only touches that folder and never leaves it. Names are plain names, sizes are capped, files are written 0600 in 0700 folders by atomic rename.
//
// Nothing here follows a symlink. A project's home is where chat sessions run and write, so a session (or anything that can create a file there) can plant one: every folder component is checked with
// lstat, files are opened with O_NOFOLLOW and must be regular, the real path must stay inside the root's real path (and the open descriptor too, on Linux), writes go to a fresh temp file created with
// O_EXCL and are renamed into place (a rename replaces a planted link, never follows it), and the real path is checked again before the rename.
//
// Context items are three kinds, all files in <root>/context/: an uploaded file (its own name), a note (`<name>.md`, text), and a reference to something in Vyre Files (`<name>.link`, a one-line JSON
// { "files": "<path in Files>" }). A reference holds a path, never the bytes: the target is read through Files, where the reader's own access decides.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DOC_FILES = Object.freeze(["AGENTS.md", "CLAUDE.md"]);
export const DOC_MAX = 64 * 1024;
export const CONTEXT_MAX = 10 * 1024 * 1024;
export const CONTEXT_FILES_MAX = 200;
export const NOTE_MAX = 64 * 1024;

const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
/** Whether `f` is `dir` or lies inside it. @param {string} dir @param {string} f */
export const inside = (dir, f) => { const r = path.relative(dir, f); return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r)); };
/** A name is a name and nothing more. @param {unknown} s */
export const plainName = s => String(s ?? "").trim().split(/[\\/]/).pop().replace(/^\.+/, "").trim();

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const NONBLOCK = fs.constants.O_NONBLOCK || 0;
const ctxName = "context";
const unsafe = () => bad("a link or a file is where a folder should be, so it was left alone", "unsafe_path");
const within = (/** @type {string} */ p, /** @type {string} */ root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** The directory `root/<dirs...>`, every component lstat-checked (none a symlink), created 0700 when asked. @param {string} root @param {string[]} dirs @param {boolean} create */
function safeDir(root, dirs, create) {
  let cur = fs.realpathSync(root);
  for (const d of dirs) {
    cur = path.join(cur, d);
    let st = null;
    try { st = fs.lstatSync(cur); } catch { st = null; }
    if (!st) { if (!create) throw Object.assign(new Error("no such folder"), { code: "not_found" }); fs.mkdirSync(cur, { mode: 0o700 }); st = fs.lstatSync(cur); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw unsafe();
  }
  return cur;
}

/** A regular file read without following a link, or null: not a plain file, too big, or anywhere outside the root. @param {string} root @param {string[]} dirs @param {string} name @param {number} max */
function readSafe(root, dirs, name, max) {
  let fd = -1;
  try {
    const dir = safeDir(root, dirs, false), full = path.join(dir, name), real = fs.realpathSync(root);
    const l = fs.lstatSync(full);
    if (!l.isFile()) return null;
    fd = fs.openSync(full, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max || st.ino !== l.ino || st.dev !== l.dev) return null;
    if (!within(fs.realpathSync(full), real)) return null;
    // Linux: the descriptor says where the file it opened really is, which no swap after the open can change.
    if (process.platform === "linux" && !within(fs.readlinkSync(`/proc/self/fd/${fd}`), real)) return null;
    const buf = Buffer.alloc(st.size);
    let n = 0; while (n < st.size) { const r = fs.readSync(fd, buf, n, st.size - n, n); if (!r) break; n += r; }
    return buf.subarray(0, n);
  } catch { return null; } finally { if (fd >= 0) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/** Write a file in `root/<dirs...>`, creating folders, never through a link. @param {string} root @param {string[]} dirs @param {string} name @param {string | Buffer} data */
function writeSafe(root, dirs, name, data) {
  const real = fs.realpathSync(root);
  const dir = safeDir(root, dirs, true);
  const dest = path.join(dir, name);
  const tmp = path.join(dir, `.vyre-${crypto.randomBytes(6).toString("hex")}.tmp`);
  const drop = () => { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } };
  try { fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" }); } catch (e) { drop(); throw e; }
  try {
    // the folder must still be the folder that was checked, and the file we made must really be inside the root (a swap between the check and the write)
    safeDir(root, dirs, false);
    if (!within(fs.realpathSync(tmp), real)) throw unsafe();
    fs.renameSync(tmp, dest);
  } catch (e) { drop(); throw e; }
}

/**
 * The two instruction files of a folder. @param {string} root
 * @returns {{ "AGENTS.md": string, "CLAUDE.md": string }}
 */
export function readDocs(root) {
  /** @type {any} */ const out = {};
  for (const f of DOC_FILES) { const b = readSafe(root, [], f, DOC_MAX); out[f] = b ? b.toString("utf8") : ""; }
  return out;
}

/**
 * Write one instruction file. With `sync`, AGENTS.md and CLAUDE.md are kept the same (a project: Claude Code reads CLAUDE.md, every other tool reads AGENTS.md), whichever is written.
 * @param {string} root @param {string} file @param {string} text @param {{ sync?: boolean }} [o]
 */
export function writeDocs(root, file, text, o = {}) {
  if (!DOC_FILES.includes(file)) throw bad(`file is ${DOC_FILES.join(" or ")}`);
  if (typeof text !== "string" || Buffer.byteLength(text) > DOC_MAX) throw bad(`the text is up to ${DOC_MAX / 1024} KB`);
  for (const f of o.sync ? DOC_FILES : [file]) writeSafe(root, [], f, text);
}

/** @param {string} root @returns {{ name: string, kind: "file" | "note" | "link", size: number, at: number, files?: string }[]} */
export function listContext(root) {
  let dir, ents;
  try { dir = safeDir(root, [ctxName], false); ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  /** @type {any[]} */ const out = [];
  for (const e of ents) {
    if (e.name.endsWith(".tmp") || e.name.startsWith(".vyre-")) continue;
    let l; try { l = fs.lstatSync(path.join(dir, e.name)); } catch { continue; }
    if (!l.isFile()) continue;   // a link, a folder or anything else is not an item (lstat: a link to a file is not a file)
    const base = { name: e.name, size: l.size, at: Math.round(l.mtimeMs) };
    if (e.name.endsWith(".link")) {
      let files = "";
      const b = readSafe(root, [ctxName], e.name, 4096);
      if (b) { try { files = String(JSON.parse(b.toString("utf8")).files || ""); } catch { /* an unreadable link names nothing */ } }
      out.push({ ...base, kind: "link", files });
    } else out.push({ ...base, kind: e.name.endsWith(".md") ? "note" : "file" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {string} root @param {string} name @param {Buffer} buf */
export function addContextFile(root, name, buf) {
  const n = plainName(name);
  if (!n || n.length > 120 || /[\u0000-\u001f]/.test(n) || n.endsWith(".tmp") || n.startsWith(".vyre-")) throw bad("give the file a plain name");
  if (buf.length > CONTEXT_MAX) throw bad("a context file is up to 10 MB");
  if (!listContext(root).some(c => c.name === n) && listContext(root).length >= CONTEXT_FILES_MAX) throw bad(`up to ${CONTEXT_FILES_MAX} context items`);
  writeSafe(root, [ctxName], n, buf);
  return { name: n, size: buf.length };
}

/** A note: text kept as `<name>.md`. @param {string} root @param {string} name @param {string} text */
export function addNote(root, name, text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > NOTE_MAX) throw bad(`a note is up to ${NOTE_MAX / 1024} KB`);
  const n = plainName(name).replace(/\.md$/i, "");
  if (!n) throw bad("give the note a name");
  return addContextFile(root, `${n}.md`, Buffer.from(text));
}

/** A reference to something in Vyre Files: a path inside Files, kept as `<name>.link`. It holds the path only. @param {string} root @param {string} name @param {string} filesPath */
export function addLink(root, name, filesPath) {
  if (typeof filesPath !== "string" || !filesPath.trim() || filesPath.length > 1024 || /[\u0000-\u001f]/.test(filesPath) || filesPath.split("/").some(s => s === "..")) throw bad("name a place in Files, such as Clients/Rivera/intake.pdf");
  const n = plainName(name).replace(/\.link$/i, "");
  if (!n) throw bad("give the reference a name");
  return addContextFile(root, `${n}.link`, Buffer.from(JSON.stringify({ files: filesPath.trim().replace(/^\/+/, "") })));
}

/** @param {string} root @param {string} name */
export function removeContext(root, name) {
  const n = plainName(name);
  let f;
  try { f = path.join(safeDir(root, [ctxName], false), n); } catch { f = ""; }
  let l = null; try { l = f ? fs.lstatSync(f) : null; } catch { l = null; }
  // a planted link is listed nowhere, so it is not removed by name either; only a plain file in the folder is
  if (!n || !l || !l.isFile()) throw Object.assign(new Error(`no context item ${name}`), { code: "not_found" });
  fs.rmSync(f);
}

/** A cap on what instructions add to a brief. @param {string} s @param {number} n */
export const clip = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + " ...");
