// @ts-check
// import/formats/shared: what every agent reader does the same way. A reader opens ONLY files that
// match its allowlist of transcript shapes, never follows a symlink, and never lists a folder that
// can hold credentials (Codex auth.json, Gemini oauth_creds.json and .env sit beside the sessions,
// never inside the folders a reader is allowed to list).

import fs from "node:fs";
import path from "node:path";

/** The most a reader takes from the head of a file to find its folder (metadata only). */
export const HEAD_MAX = 256 * 1024;
/** Names that are never opened or listed, whatever a path says. */
export const CREDENTIAL_NAME = /(?:^|\/)(?:auth\.json|oauth_creds\.json|google_accounts\.json|installation_id|\.credentials\.json|\.env(?:\..*)?|.*\.(?:pem|key))$/i;

/**
 * Sub-folders of `dir` (regular folders only, never a link), whose names match `re`, sorted.
 * @param {string} dir @param {RegExp} re
 */
export function subdirs(dir, re) {
  return ents(dir).filter(e => e.isDirectory() && re.test(e.name)).map(e => path.join(dir, e.name)).sort();
}
/** Regular files (never a link) in `dir` whose names match `re`. @param {string} dir @param {RegExp} re */
export function files(dir, re) {
  return ents(dir).filter(e => e.isFile() && re.test(e.name) && !CREDENTIAL_NAME.test(e.name)).map(e => path.join(dir, e.name)).sort();
}
/** @param {string} dir */
function ents(dir) {
  try { if (!fs.lstatSync(dir).isDirectory()) return []; return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Whether `file` is under `home` at a relative path the allowlist accepts. @param {string} home @param {string} file @param {RegExp} allow */
export function allowed(home, file, allow) {
  const rel = path.relative(path.resolve(home), path.resolve(file)).split(path.sep).join("/");
  return !rel.startsWith("..") && !path.isAbsolute(rel) && allow.test(rel) && !CREDENTIAL_NAME.test(rel);
}

/**
 * Open an allowlisted file for reading, refusing anything else: a path outside the allowlist, a
 * symlink, or anything that is not a regular file. Returns the fd, or throws.
 * @param {string} home @param {string} file @param {RegExp} allow
 */
export function openAllowed(home, file, allow) {
  if (!allowed(home, file, allow)) throw Object.assign(new Error("not a transcript file this reader may open"), { code: "denied" });
  if (!fs.lstatSync(file).isFile()) throw Object.assign(new Error("not a regular file"), { code: "denied" });
  return fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
}

/** The first `max` bytes of an allowlisted file as text. @param {string} home @param {string} file @param {RegExp} allow */
export function headText(home, file, allow, max = HEAD_MAX) {
  const fd = openAllowed(home, file, allow);
  try { const buf = Buffer.alloc(max); const n = fs.readSync(fd, buf, 0, max, 0); return buf.subarray(0, n).toString("utf8"); } finally { fs.closeSync(fd); }
}
/** A whole allowlisted file as text. @param {string} home @param {string} file @param {RegExp} allow */
export function readAllowed(home, file, allow) {
  const fd = openAllowed(home, file, allow);
  try { return fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
}

/** One line of Claude Code's transcript shape. @param {object} o */
export const line = o => JSON.stringify(o) + "\n";

/** Text of a tool result of any shape, as a string. @param {any} v */
export function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join("\n");
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (v.functionResponse) return textOf(v.functionResponse.response ?? v.functionResponse);
    for (const k of ["output", "content", "result", "stdout"]) if (v[k] != null) return textOf(v[k]);
    try { return JSON.stringify(v); } catch { return ""; }
  }
  return String(v);
}

/** Claude Code's folder name for a working folder (every non-alphanumeric becomes "-"). @param {string|null} cwd */
export const folderName = cwd => (cwd ? cwd.replace(/[^A-Za-z0-9]/g, "-") : "-unknown");
