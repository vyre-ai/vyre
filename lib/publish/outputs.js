// @ts-check
// lib/publish/outputs.js: what a build may hand Publish as site files. Only regular files by a plain relative path. A link of any kind (symbolic or hard), a device, a pipe, a socket, an
// absolute path, a `..` segment or a path that repeats is refused whole: a symlink in a static site would let a link to `.env`, `/etc/passwd` or `/run/secrets/<name>` through the
// edge's dotfile rule and out of the site (reviewer-3, PB-1). The place that fills a site's volume checks the same rule again on what it writes.
import { fail } from "./util.js";

const MAX_PATH = 1024;

/**
 * @param {Array<{ path: string, content?: string | Uint8Array, type?: string, mode?: number, link?: string, symlink?: string, target?: string, linkname?: string }>} files
 * @returns {void} throws a PublishError (bad_output) naming the first offending path
 */
export function checkOutputFiles(files) {
  const seen = new Set();
  /** @type {string[]} */ const keys = [];
  for (const f of files) {
    const p = f && typeof f.path === "string" ? f.path : "";
    const shown = p.slice(0, 80).replace(/[^\x20-\x7e]/g, "?");
    if (!f || typeof f !== "object" || !p) fail("bad_output", "a build file has no path");
    if (p.length > MAX_PATH || /[\u0000-\u001f\u007f\\]/.test(p)) fail("bad_output", `the build file path ${shown} is not a plain path`);
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").some(s => s === ".." || s === "" || s === ".")) fail("bad_output", `the build file path ${shown} must be a plain relative path`);
    if (f.type !== undefined && f.type !== "file") fail("bad_output", `the build file ${shown} is a ${String(f.type).slice(0, 20)}; only regular files are published`);
    for (const k of ["link", "symlink", "target", "linkname"]) if (/** @type {any} */ (f)[k] !== undefined) fail("bad_output", `the build file ${shown} is a link; only regular files are published`);
    if (f.mode !== undefined && (!Number.isInteger(f.mode) || (f.mode & 0o170000) !== 0 && (f.mode & 0o170000) !== 0o100000)) fail("bad_output", `the build file ${shown} is not a regular file`);
    if (!(typeof f.content === "string" || f.content instanceof Uint8Array)) fail("bad_output", `the build file ${shown} has no content`);
    // Names compare as the filesystem will see them: case folded and Unicode-normalised, so `a.html` and `A.HTML`, or a precomposed and a decomposed name, cannot both land.
    const key = p.normalize("NFC").toLowerCase().normalize("NFC");
    if (seen.has(key)) fail("bad_output", `the build file ${shown} appears twice`);
    seen.add(key);
    keys.push(key);
  }
  // A name that is a file in one entry and a folder in another (`a` and `a/b`) cannot both exist.
  const set = new Set(keys);
  for (const k of keys) { const segs = k.split("/"); for (let i = 1; i < segs.length; i++) if (set.has(segs.slice(0, i).join("/"))) fail("bad_output", `the build file ${k.slice(0, 80)} sits inside another build file`); }
}
