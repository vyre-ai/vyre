// @ts-check
// folder-docs: an agent's or a project's Instructions (AGENTS.md and CLAUDE.md) and Context (a context/ folder), read and written in ONE place, over a folder root. The caller says which folder
// (agentDir(id) or a project's home) and who may; this file only touches that folder and never leaves it. Names are plain names, sizes are capped, files are written 0600 in 0700 folders by atomic rename.
//
// Context items are three kinds, all files in <root>/context/: an uploaded file (its own name), a note (`<name>.md`, text), and a reference to something in Vyre Files (`<name>.link`, a one-line JSON
// { "files": "<path in Files>" }). A reference holds a path, never the bytes: the target is read through Files, where the reader's own access decides.

import fs from "node:fs";
import path from "node:path";

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

const ctxDir = (/** @type {string} */ root) => path.join(root, "context");
const ensure = (/** @type {string} */ dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const atomic = (/** @type {string} */ f, /** @type {string | Buffer} */ data) => { ensure(path.dirname(f)); fs.writeFileSync(f + ".tmp", data, { mode: 0o600 }); fs.renameSync(f + ".tmp", f); };

/**
 * The two instruction files of a folder. @param {string} root
 * @returns {{ "AGENTS.md": string, "CLAUDE.md": string }}
 */
export function readDocs(root) {
  /** @type {any} */ const out = {};
  for (const f of DOC_FILES) { try { out[f] = fs.readFileSync(path.join(root, f), "utf8"); } catch { out[f] = ""; } }
  return out;
}

/**
 * Write one instruction file. With `sync`, AGENTS.md and CLAUDE.md are kept the same (a project: Claude Code reads CLAUDE.md, every other tool reads AGENTS.md), whichever is written.
 * @param {string} root @param {string} file @param {string} text @param {{ sync?: boolean }} [o]
 */
export function writeDocs(root, file, text, o = {}) {
  if (!DOC_FILES.includes(file)) throw bad(`file is ${DOC_FILES.join(" or ")}`);
  if (typeof text !== "string" || Buffer.byteLength(text) > DOC_MAX) throw bad(`the text is up to ${DOC_MAX / 1024} KB`);
  for (const f of o.sync ? DOC_FILES : [file]) atomic(path.join(root, f), text);
}

/** @param {string} root @returns {{ name: string, kind: "file" | "note" | "link", size: number, at: number, files?: string }[]} */
export function listContext(root) {
  const dir = ctxDir(root);
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && !e.name.endsWith(".tmp")); } catch { return []; }
  return ents.map(e => {
    const s = fs.statSync(path.join(dir, e.name));
    const base = { name: e.name, size: s.size, at: Math.round(s.mtimeMs) };
    if (e.name.endsWith(".link")) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, e.name), "utf8")); return { ...base, kind: /** @type {const} */ ("link"), files: String(j.files || "") }; } catch { return { ...base, kind: /** @type {const} */ ("link"), files: "" }; } }
    return { ...base, kind: /** @type {"file" | "note"} */ (e.name.endsWith(".md") ? "note" : "file") };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {string} root @param {string} name @param {Buffer} buf */
export function addContextFile(root, name, buf) {
  const n = plainName(name);
  if (!n || n.length > 120 || /[\u0000-\u001f]/.test(n) || n.endsWith(".tmp")) throw bad("give the file a plain name");
  if (buf.length > CONTEXT_MAX) throw bad("a context file is up to 10 MB");
  const dir = ctxDir(root), f = path.join(dir, n);
  if (!inside(dir, f) || f === dir) throw bad("give the file a plain name");
  if (!fs.existsSync(f) && listContext(root).length >= CONTEXT_FILES_MAX) throw bad(`up to ${CONTEXT_FILES_MAX} context items`);
  atomic(f, buf);
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
  const dir = ctxDir(root), f = path.join(dir, plainName(name));
  if (!plainName(name) || !inside(dir, f) || f === dir || !fs.existsSync(f)) throw Object.assign(new Error(`no context item ${name}`), { code: "not_found" });
  fs.rmSync(f);
}

/** A cap on what instructions add to a brief. @param {string} s @param {number} n */
export const clip = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + " ...");
