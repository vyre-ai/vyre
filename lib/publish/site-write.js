// @ts-check
// lib/publish/site-write.js: how a build's files get into a site's volume, the one way. The list goes through outputs.js first (regular files, plain relative paths, nothing else); then it is
// written into a FRESH temp folder this process owns, one file at a time, each opened O_CREAT|O_EXCL|O_NOFOLLOW so an existing entry or a link of any kind stops the write, and every
// folder made one segment at a time and checked to be a real folder. Nothing a builder produced as a directory is ever copied or extracted: only the checked list is written. The box
// then copies that folder into the empty volume (`volumeFill`) in a throwaway container with no network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkOutputFiles } from "./outputs.js";
import { fail } from "./util.js";
import { IMAGES } from "./edge.js";

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const VOLUME_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const SITE_UID = 65532;
/** What mkdtemp("site-") makes. */
export const SITE_DIR_RE = /^site-[A-Za-z0-9]{6}$/;

/**
 * The site folder a record names, or null when it is not one of ours: the name must be `site-XXXXXX`, and the folder must be a real directory (not a link), owned by this process, mode 0700.
 * @param {string} root the space's sites folder @param {unknown} name
 */
export function siteFolder(root, name) {
  if (typeof name !== "string" || !SITE_DIR_RE.test(name)) return null;
  const dir = path.join(root, name);
  try {
    const st = fs.lstatSync(dir);
    const mine = typeof process.getuid !== "function" || st.uid === process.getuid();
    return st.isDirectory() && !st.isSymbolicLink() && mine && (st.mode & 0o777) === 0o700 ? dir : null;
  } catch { return null; }
}

/**
 * Remove every site folder under `root` that no live deployment names, and then the oldest beyond `max`. A folder younger than `graceMs` is never touched: a preview writes its folder before its
 * record exists, so a second preview at the same time must not take it (reviewer-3, SW-1).
 * @param {string} root @param {Set<string>} keep @param {number} [max] @param {number} [graceMs] @param {number} [now]
 */
export function sweepSites(root, keep, max = 50, graceMs = 3_600_000, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(root).filter(n => SITE_DIR_RE.test(n)); } catch { return 0; }
  const info = names.map(n => { try { return { n, t: fs.statSync(path.join(root, n)).mtimeMs }; } catch { return null; } }).filter(/** @returns {x is {n: string, t: number}} */ x => x !== null);
  const old = info.filter(x => now - x.t >= graceMs);
  let removed = 0;
  const rm = (/** @type {string} */ n) => { try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); removed++; } catch { /* left for the next sweep */ } };
  for (const x of old) if (!keep.has(x.n)) rm(x.n);
  const left = old.filter(x => keep.has(x.n)).sort((a, b) => a.t - b.t);
  for (const x of left.slice(0, Math.max(0, left.length - max))) rm(x.n);
  return removed;
}

/**
 * Write the files into a new folder under `parent`. Returns the folder. On any failure the new folder is removed and nothing is left behind.
 * @param {string} parent an existing folder this process owns (the publish folder's scratch)
 * @param {Array<{ path: string, content: string | Uint8Array }>} files
 */
export function writeSiteFiles(parent, files) {
  checkOutputFiles(files);
  if (!path.isAbsolute(parent) || !fs.statSync(parent).isDirectory()) fail("bad_input", "the scratch folder must be an existing absolute folder");
  const root = fs.mkdtempSync(path.join(parent, "site-"));
  try {
    fs.chmodSync(root, 0o700);
    for (const f of files) {
      const segs = f.path.split("/");
      let cur = root;
      for (const seg of segs.slice(0, -1)) {
        cur = path.join(cur, seg);
        try { fs.mkdirSync(cur, { mode: 0o755 }); } catch (e) { if (/** @type {any} */ (e).code !== "EEXIST") throw e; }
        if (!fs.lstatSync(cur).isDirectory()) fail("bad_output", `the build file ${f.path.slice(0, 80)} would need a folder where there is not one`);
      }
      const fd = fs.openSync(path.join(cur, segs[segs.length - 1]), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o444);
      try { fs.writeSync(fd, typeof f.content === "string" ? Buffer.from(f.content) : f.content); } finally { fs.closeSync(fd); }
    }
    return root;
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

/**
 * The `docker` arguments that copy a folder made by writeSiteFiles into a site's empty volume, owned by the site's user and read-only. A throwaway container: no network, no capability but
 * the two it needs, the folder mounted read-only. The folder must be a `site-XXXXXX` folder directly under `root` (the space's sites folder), and the volume name is checked here; neither can
 * carry a mount option or point anywhere else.
 * @param {string} dir @param {string} volume @param {string} root @param {string} [image]
 */
export function volumeFill(dir, volume, root, image = IMAGES.alpine) {
  if (!path.isAbsolute(dir) || /[:,\0\n]/.test(dir)) fail("bad_input", "a plain absolute folder is required");
  if (typeof root !== "string" || !path.isAbsolute(root) || path.dirname(dir) !== root.replace(/\/+$/, "") || !SITE_DIR_RE.test(path.basename(dir))) fail("bad_input", "the folder is not one of this space's site folders");
  if (!VOLUME_RE.test(volume)) fail("bad_input", "a plain volume name is required");
  return ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "-v", `${dir}:/in:ro`, "-v", `${volume}:/srv`, image,
    "sh", "-c", `cp -R /in/. /srv/ && chmod -R a-w /srv && chown -R ${SITE_UID}:${SITE_UID} /srv`];
}

/** The scratch parent when the caller has none: a folder under the OS temp dir, private to this process. */
export const scratchParent = () => fs.mkdtempSync(path.join(os.tmpdir(), "vyre-publish-"));
