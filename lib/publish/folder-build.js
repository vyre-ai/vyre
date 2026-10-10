// @ts-check
// lib/publish/folder-build.js: a folder of ready files becomes a build result, with no command run. The folder is read as it really is on disk: a link is never followed, `.git` and `node_modules` and
// secret-looking files (an .env, a private key) are left out and named, and a folder over the limits is refused. The digest is over the paths and the contents, so the same folder is the same build.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail } from "./util.js";
import { finders } from "../credential-shapes.js";

export const LIMITS = Object.freeze({ files: 2000, bytes: 50 * 1024 * 1024, file: 10 * 1024 * 1024, depth: 12 });
const SKIP_DIRS = new Set([".git", "node_modules", ".sessions", ".vyre"]);
const SECRET_SHAPES = finders("push");
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0, NONBLOCK = fs.constants.O_NONBLOCK || 0;
const SKIP_FILES = /^(?:\.env(?:\..*)?|\.DS_Store|Thumbs\.db|id_(?:rsa|ed25519|ecdsa).*|.*\.(?:pem|key|p12|pfx))$/i;

/** Text, for the credential scan: no NUL byte in the first 4 KB. @param {Buffer} b */
const looksText = b => !b.subarray(0, 4096).includes(0);

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
  const note = (/** @type {string} */ what) => { if (skipped.length < 100) skipped.push(what); };
  let bytes = 0;
  /** @param {string} d @param {number} depth */
  const walk = (d, depth) => {
    if (depth > limits.depth) fail("too_large", `the folder is nested more than ${limits.depth} levels deep`);
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name), rel = path.relative(out, full).split(path.sep).join("/");
      if (e.isSymbolicLink()) { note(`${rel} (a link)`); continue; }
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) { note(`${rel}/`); continue; } walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (SKIP_FILES.test(e.name)) { note(rel); continue; }
      if (files.length + 1 > limits.files) fail("too_large", `the folder has more than ${limits.files} files`);
      // Opened without following a link and not blocking, then judged by what was opened: a file swapped for a link or a pipe between the listing and the read is skipped, not followed or waited on.
      let fd;
      try {
        fd = fs.openSync(full, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
        const st = fs.fstatSync(fd);
        if (!st.isFile()) { note(`${rel} (not a plain file)`); continue; }
        if (st.size > limits.file) fail("too_large", `${rel} is over ${Math.round(limits.file / 1048576)} MB`);
        bytes += st.size;
        if (bytes > limits.bytes) fail("too_large", `the folder is over ${Math.round(limits.bytes / 1048576)} MB`);
        const content = fs.readFileSync(fd);
        const text = looksText(content) ? content.toString("utf8") : "";
        for (const f of SECRET_SHAPES) if (text && f.re.test(text)) fail("secret_in_build", `${rel} looks like it holds a ${f.name}; take it out of the folder before publishing`);
        files.push({ path: rel, content });
      } catch (/** @type {any} */ e) {
        if (e && (e.code === "ELOOP" || e.code === "ENXIO")) { note(`${rel} (a link)`); continue; }
        throw e;
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  };
  walk(out, 0);
  if (!files.length) fail("bad_input", "the folder has no files to publish");
  const lines = files.map(f => `${f.path}\0${crypto.createHash("sha256").update(f.content).digest("hex")}\n`).sort().join("");
  return { files, skipped, bytes, digest: "sha256:" + crypto.createHash("sha256").update(lines).digest("hex"), name: path.basename(root) };
}

/**
 * May this caller name this folder as a deployment's source? Naming a folder on the server is the person's act: a model session never does, because whatever sits in that folder goes to the internet on the
 * person's yes and a prompt-injected model could point it at somebody's files. Answers a plain refusal, or null when it is fine.
 * @param {string} ref @param {{ person: boolean }} who @returns {{ code: string, message: string } | null}
 */
export function folderRefusal(ref, { person }) {
  if (!person) return { code: "denied", message: "naming a folder on this server is the person's; ask them to publish it from the preview card or the terminal" };
  let real;
  try { real = fs.realpathSync(ref); } catch { return { code: "not_found", message: "that folder is not on this server" }; }
  if (!fs.statSync(real).isDirectory()) return { code: "bad_input", message: "the source is not a folder" };
  return null;
}
