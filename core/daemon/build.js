// @ts-check
// build: which Vyre this is, beyond the version number. A release stamps build.json into the
// package (scripts/build-site.sh, the one step that packs vyre.tgz for npm and the box image), so
// two boxes on 0.0.1 can still say whether they run the same code. A checkout has no build.json
// and asks git instead, once, and only when something wants to know: never on a plain CLI start.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitSync } from "../../lib/git-safe.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @typedef {{ version: string, commit: string | null, dirty: boolean | null, stamped: boolean }} Build */

/** @type {Build | null} */
let memo = null;

/** { version, commit, dirty, stamped }. commit and dirty are null when neither a stamp nor git
 * can say. `stamped` is explicit, never left undefined, in every branch - pwa's ?relay= dev-
 * build gate (deck/views/wink.js) reads it over system.info and needs a real false, not an
 * absent field, to fail closed on an old or unusual box (reviewer's LOW, 2026-09-28).
 * @returns {Build} */
export function build(repo = REPO) {
  if (memo && repo === REPO) return memo;
  const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
  /** @type {Build} */
  let b = { version, commit: null, dirty: null, stamped: false };
  try {
    const s = JSON.parse(fs.readFileSync(path.join(repo, "build.json"), "utf8"));
    b = { version, commit: typeof s.commit === "string" ? s.commit : null, dirty: typeof s.dirty === "boolean" ? s.dirty : null, stamped: true };
  } catch {
    if (fs.existsSync(path.join(repo, ".git"))) {
      const git = (/** @type {string[]} */ ...a) => { const r = gitSync(repo, a, { timeout: 3000 }); if (!r.ok) throw new Error("git failed"); return r.stdout.trim(); };
      try { b = { version, commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=no") !== "", stamped: false }; } catch { /* no git on PATH */ }
    }
  }
  if (repo === REPO) memo = b;
  return b;
}

/** "0.0.1 · 1a2b3c4" or "0.0.1 · 1a2b3c4+dirty": for a status line. */
export function label(/** @type {Build} */ b) {
  return b.commit ? `${b.version} · ${b.commit.slice(0, 7)}${b.dirty ? "+dirty" : ""}` : b.version;
}

/** The id every surface compares: the commit (12 characters, "-dirty" when dirty), else "v" and
 * the version. deck/js/build-check.js computes the same from system.info. */
export function buildId(/** @type {Build} */ b = build()) {
  const id = b.commit ? b.commit.slice(0, 12) + (b.dirty ? "-dirty" : "") : "v" + b.version;
  return id.replace(/[^\w.-]/g, "");
}

/** deck/sw.js with BUILD set to this build's id. Also sets SHELL_SIGNED true when web/release/SHA256SUMS.sig
 * exists (put there by the release: vyre update, the phone.vyre.run deploy), so the worker checks a new
 * shell against the signed release (reviewer's N-H1). No such file (every dev checkout and testbox) leaves it false. @param {string} repo */
export function swWithBuild(/** @type {string} */ src, b = build(), repo = REPO) {
  let out = src.replace('const BUILD = "dev";', `const BUILD = ${JSON.stringify(buildId(b))};`);
  if (fs.existsSync(path.join(repo, "web", "release", "SHA256SUMS.sig"))) out = out.replace("const SHELL_SIGNED = false;", "const SHELL_SIGNED = true;");
  return out;
}

/** deck/index.html with its vyre-build meta set to this build's id, so a page cached by an older
 * service worker knows it is older than the box it talks to (deck/js/build-check.js). */
export function htmlWithBuild(/** @type {string} */ src, b = build()) {
  return src.replace('<meta name="vyre-build" content="dev">', `<meta name="vyre-build" content="${buildId(b)}">`);
}
