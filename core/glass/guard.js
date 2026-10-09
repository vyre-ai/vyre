// @ts-check
// guard: the one place Glass checks a path (ADR 0005, decision 4).
//
// Every read and write of a file, on the box or (through computerd, which applies the same list
// inside the container) on an agent's computer, passes through here first. The rules:
//
//   - a path is relative to a root: absolute input, NUL and `..` are refused outright, never
//     "cleaned up" into something else;
//   - secret places are denied at any depth and hidden from listings (DENY below);
//   - symlinks resolve inside the root or not at all: the result is realpath'd and must sit
//     inside the realpath of the root, and must not land on a denied name either.
//
// Link's `files` module (core/files/safety.js) denies the same places; this list covers every
// name it refuses, and is stricter where Glass writes (any *.key, not only files).

import fs from "node:fs";
import path from "node:path";
import { PRIVATE_KEY_HEAD } from "../../lib/credential-shapes.js";

/**
 * Names denied at any depth. A plain name matches a path segment exactly (case-insensitively:
 * macOS and most phones fold case, so ".SSH" is .ssh); `*` is a wildcard within one segment; a
 * name with a slash matches those segments in a row.
 */
export const DENY = Object.freeze([
  ".vyre", ".claude", ".claude.json", ".ssh", ".gnupg", ".aws", ".docker", ".kube", ".config/gcloud",
  ".git-credentials", ".netrc", ".npmrc", ".pypirc", ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx",
  "*.kdbx", "*.keychain*", "id_*", "credentials.json", "service-account*.json",
  "Cookies", "Login Data", "Login Data For Account", "Web Data", "secrets", ".vnc",
]);

/**
 * A private key, whatever the file is called: PEM, OpenSSH and PuTTY all say so in their first
 * line. The same test link's files module applies (core/files/safety.js).
 */
export const KEY_HEAD = PRIVATE_KEY_HEAD;
export const KEY_SNIFF = 512;

/** Do these first bytes of a file say it is a private key? */
export const isKeyBytes = buf => KEY_HEAD.test(Buffer.from(buf).subarray(0, KEY_SNIFF).toString("latin1"));

/** Glass's own working files: never listed, and never the name of something a person makes. */
export const TRASH = ".vyre-trash";
export const UPLOAD_PREFIX = ".vyre-upload-";

/** Caps, from the ADR. The upload cap is config (glass.maxUploadMb); this is its default. */
export const MAX_ENTRIES = 5000;
export const MAX_PREVIEW = 256 * 1024;
export const DEFAULT_UPLOAD_MB = 200;

const glob = s => new RegExp("^" + s.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
const RULES = DENY.map(d => d.split("/").map(glob));

/** Does a list of path segments touch a denied place? */
export function deniedSegments(segments) {
  const low = segments.map(s => String(s).toLowerCase());
  for (const rule of RULES) {
    for (let i = 0; i + rule.length <= low.length; i++) {
      if (rule.every((re, j) => re.test(low[i + j]))) return true;
    }
  }
  return false;
}

/** Is one entry, seen in a listing of `parentSegments`, hidden? Denied names and Glass's own files. */
export function hidden(name, parentSegments = []) {
  if (name === TRASH || name.startsWith(UPLOAD_PREFIX)) return true;
  return deniedSegments([...parentSegments, name]);
}

/**
 * Check a relative path and return its normalized segments. Throws with a reason a person can
 * read. An empty path ("" or ".") is the root itself: no segments.
 * @param {unknown} rel
 * @returns {string[]}
 */
export function checkRel(rel) {
  if (rel === undefined || rel === null) rel = "";
  if (typeof rel !== "string") throw new Error("a path must be a string");
  if (rel.includes("\0")) throw new Error("a path may not contain NUL");
  if (rel.length > 4096) throw new Error("that path is too long");
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel) || /^~(?:[\\/]|$)/.test(rel))throw new Error(`"${rel}" is absolute; paths are relative to a root`);
  const raw = rel.split(/[\\/]+/);
  if (raw.includes("..")) throw new Error(`"${rel}" climbs out with ..; paths stay inside their root`);
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
  const segments = norm === "." ? [] : norm.split("/").filter(s => s && s !== ".");
  if (segments.includes("..")) throw new Error(`"${rel}" climbs out with ..; paths stay inside their root`);
  if (deniedSegments(segments)) throw new Error(`"${rel}" is a private place Glass does not open`);
  return segments;
}

/** Is `p` the directory `dir` or inside it? Both must already be real paths. */
export function inside(dir, p) {
  return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** A name for a new file or folder: one segment, not denied, not one of Glass's own. */
export function checkName(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\0]/.test(name) || name.length > 255) throw new Error(`"${name}" is not a file name`);
  if (hidden(name)) throw new Error(`"${name}" is a private name Glass does not create`);
  return name;
}

/**
 * Resolve `rel` inside `root` on this machine's disk, following symlinks, and refuse anything
 * that ends outside the root or on a denied name. For a path that must not exist yet (a new
 * folder, an upload, a move's destination) pass `{ create: true }`: then its parent is resolved
 * and must be a folder inside the root, and the result is the parent's real path plus the name.
 * @param {string} root an absolute folder
 * @param {unknown} rel
 * @param {{ create?: boolean }} [opts]
 * @returns {{ abs: string, real: string, segments: string[] }}
 */
export function resolveIn(root, rel, opts = {}) {
  const segments = checkRel(rel);
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { throw new Error("that root is not there any more"); }
  const abs = path.join(realRoot, ...segments);
  const escape = () => new Error(`"${rel}" leads outside its root`);
  const within = real => {
    if (!inside(realRoot, real)) throw escape();
    const under = path.relative(realRoot, real);
    if (under && deniedSegments(under.split(path.sep))) throw new Error(`"${rel}" leads to a private place Glass does not open`);
    return real;
  };
  if (opts.create) {
    if (!segments.length) throw new Error("a root cannot be made or replaced");
    checkName(segments[segments.length - 1]);
    let parent;
    try { parent = fs.realpathSync(path.dirname(abs)); } catch { throw new Error(`the folder for "${rel}" does not exist`); }
    within(parent);
    if (!fs.statSync(parent).isDirectory()) throw new Error(`the folder for "${rel}" is not a folder`);
    const target = path.join(parent, segments[segments.length - 1]);
    // An existing symlink at the destination would redirect a write: resolve it like any read.
    let st = null;
    try { st = fs.lstatSync(target); } catch {}
    if (st && st.isSymbolicLink()) {
      let real;
      try { real = fs.realpathSync(target); } catch { throw escape(); }
      within(real);
    }
    return { abs, real: target, segments };
  }
  let real;
  try { real = fs.realpathSync(abs); }
  catch (e) { throw new Error(/** @type {any} */ (e).code === "ENOENT" ? `"${rel}" does not exist` : `"${rel}" cannot be opened`); }
  return { abs, real: within(real), segments };
}
