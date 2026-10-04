// @ts-check
// lib/publish/site-tar.js: how a build's files get into a site's volume. The files are checked (outputs.js: regular files by plain relative paths, nothing else) and written as a tar
// archive built here, which holds only regular files and the directories they need, owned by the non-root user the site is served as (65532) and read-only for everyone. Because the
// archive is made from the checked list and nothing else, it cannot carry a link, a device or a path outside the site, whatever the build produced. The box extracts it into the empty
// volume with `tar x` in a throwaway container with no network and no capability but CHOWN; the extractor is never given a path of its own choosing.
import { checkOutputFiles } from "./outputs.js";
import { fail } from "./util.js";

const UID = 65532;
const enc = new TextEncoder();
const octal = (/** @type {number} */ n, /** @type {number} */ width) => n.toString(8).padStart(width - 1, "0") + "\0";

/** @param {string} name @param {number} size @param {"0"|"5"} type @param {number} mode */
function header(name, size, type, mode) {
  let prefix = "";
  let base = name;
  if (enc.encode(base).length > 100) {
    const cut = base.lastIndexOf("/", 155);
    if (cut <= 0 || enc.encode(base.slice(cut + 1)).length > 100 || enc.encode(base.slice(0, cut)).length > 155) fail("bad_output", "a build file path is too long to publish");
    prefix = base.slice(0, cut); base = base.slice(cut + 1);
  }
  const h = new Uint8Array(512);
  const put = (/** @type {string} */ s, /** @type {number} */ at) => h.set(enc.encode(s), at);
  put(base, 0); put(octal(mode, 8), 100); put(octal(UID, 8), 108); put(octal(UID, 8), 116); put(octal(size, 12), 124); put(octal(0, 12), 136);
  put("        ", 148); put(type, 156); put("ustar\0", 257); put("00", 263); put(prefix, 345);
  let sum = 0; for (const b of h) sum += b;
  put(octal(sum, 7).slice(0, 6) + "\0 ", 148);
  return h;
}

/**
 * The archive of a build's site files. Throws bad_output for anything outputs.js refuses.
 * @param {Array<{ path: string, content: string | Uint8Array }>} files @returns {Uint8Array}
 */
export function siteTar(files) {
  checkOutputFiles(files);
  /** @type {Uint8Array[]} */ const parts = [];
  const dirs = new Set();
  for (const f of files) {
    const segs = f.path.split("/");
    for (let i = 1; i < segs.length; i++) { const d = segs.slice(0, i).join("/") + "/"; if (!dirs.has(d)) { dirs.add(d); parts.push(header(d, 0, "5", 0o755)); } }
    const body = typeof f.content === "string" ? enc.encode(f.content) : f.content;
    parts.push(header(f.path, body.length, "0", 0o444), body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
