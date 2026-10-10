// @ts-check
// lib/publish/folder-build.js: a folder of ready files becomes a build result, with no command run. The folder is read as it really is on disk: a link is never followed, `.git` and `node_modules` and
// secret-looking files (an .env, a private key) are left out and named, and a folder over the limits is refused. The digest is over the paths and the contents, so the same folder is the same build.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail } from "./util.js";

export const LIMITS = Object.freeze({ files: 2000, bytes: 50 * 1024 * 1024, file: 10 * 1024 * 1024, depth: 12 });
const SKIP_DIRS = new Set([".git", "node_modules", ".sessions", ".vyre"]);
const SKIP_FILES = /^(?:\.env(?:\..*)?|\.DS_Store|Thumbs\.db|id_(?:rsa|ed25519|ecdsa).*|.*\.(?:pem|key|p12|pfx))$/i;

/**
 * @param {{ dir: string, outputDir?: string, limits?: typeof LIMITS }} p
 * @returns {{ files: { path: string, content: Buffer }[], skipped: string[], bytes: number, digest: string, name: string }}
 */
export function readSite({ dir, outputDir = ".", limits = LIMITS }) {
  let root, out;
  try { root = fs.realpathSync(dir); } catch { fail("not_found", "that folder is not there"); }
  if (!fs.statSync(root).isDirectory()) fail("bad_input", "the source is not a folder");
  try { out = fs.realpathSync(path.join(root, outputDir)); } catch { fail("not_found", `the folder has no ${outputDir}`); }
  if (!(out === root || out.startsWith(root + path.sep))) fail("bad_input", "the output folder is outside the source folder");
  if (!fs.statSync(out).isDirectory()) fail("bad_input", `${outputDir} is not a folder`);
  /** @type {{ path: string, content: Buffer }[]} */ const files = [];
  /** @type {string[]} */ const skipped = [];
  let bytes = 0;
  /** @param {string} d @param {number} depth */
  const walk = (d, depth) => {
    if (depth > limits.depth) fail("too_large", `the folder is nested more than ${limits.depth} levels deep`);
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name), rel = path.relative(out, full).split(path.sep).join("/");
      if (e.isSymbolicLink()) { skipped.push(`${rel} (a link)`); continue; }
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) { skipped.push(`${rel}/`); continue; } walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (SKIP_FILES.test(e.name)) { skipped.push(rel); continue; }
      const size = fs.statSync(full).size;
      if (size > limits.file) fail("too_large", `${rel} is over ${Math.round(limits.file / 1048576)} MB`);
      if (files.length + 1 > limits.files) fail("too_large", `the folder has more than ${limits.files} files`);
      bytes += size;
      if (bytes > limits.bytes) fail("too_large", `the folder is over ${Math.round(limits.bytes / 1048576)} MB`);
      files.push({ path: rel, content: fs.readFileSync(full) });
    }
  };
  walk(out, 0);
  if (!files.length) fail("bad_input", "the folder has no files to publish");
  const lines = files.map(f => `${f.path}\0${crypto.createHash("sha256").update(f.content).digest("hex")}\n`).sort().join("");
  return { files, skipped, bytes, digest: crypto.createHash("sha256").update(lines).digest("hex"), name: path.basename(root) };
}

/**
 * May this caller name this folder as a deployment's source? A person may name any folder on the server; a model session only one kept under Vyre's home (what it made there), so it cannot point a
 * public site at somebody's other files. Answers a plain refusal, or null when it is fine.
 * @param {string} ref @param {{ person: boolean, home: string }} who @returns {{ code: string, message: string } | null}
 */
export function folderRefusal(ref, { person, home }) {
  let real, root;
  try { real = fs.realpathSync(ref); root = fs.realpathSync(home); } catch { return { code: "not_found", message: "that folder is not on this server" }; }
  if (!fs.statSync(real).isDirectory()) return { code: "bad_input", message: "the source is not a folder" };
  if (!person && !(real === root || real.startsWith(root + path.sep))) return { code: "denied", message: "a model may publish only a folder kept under Vyre's home; ask the person to name this one" };
  return null;
}
