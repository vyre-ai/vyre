// @ts-check
// build: which Vyre this is, beyond the version number. A release stamps build.json into the
// package (scripts/build-site.sh, the one step that packs vyre.tgz for npm and the box image), so
// two boxes on 0.0.1 can still say whether they run the same code. A checkout has no build.json
// and asks git instead, once, and only when something wants to know: never on a plain CLI start.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @typedef {{ version: string, commit: string | null, dirty: boolean | null, stamped?: boolean }} Build */

/** @type {Build | null} */
let memo = null;

/** { version, commit, dirty }. commit and dirty are null when neither a stamp nor git can say. @returns {Build} */
export function build(repo = REPO) {
  if (memo && repo === REPO) return memo;
  const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
  /** @type {Build} */
  let b = { version, commit: null, dirty: null };
  try {
    const s = JSON.parse(fs.readFileSync(path.join(repo, "build.json"), "utf8"));
    b = { version, commit: typeof s.commit === "string" ? s.commit : null, dirty: typeof s.dirty === "boolean" ? s.dirty : null, stamped: true };
  } catch {
    if (fs.existsSync(path.join(repo, ".git"))) {
      const git = (/** @type {string[]} */ ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      try { b = { version, commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=no") !== "" }; } catch { /* no git on PATH */ }
    }
  }
  if (repo === REPO) memo = b;
  return b;
}

/** "0.0.1 · 1a2b3c4" or "0.0.1 · 1a2b3c4+dirty": for a status line. */
export function label(/** @type {Build} */ b) {
  return b.commit ? `${b.version} · ${b.commit.slice(0, 7)}${b.dirty ? "+dirty" : ""}` : b.version;
}
