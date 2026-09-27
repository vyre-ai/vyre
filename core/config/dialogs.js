// @ts-check
// dialogs: whether Vyre may raise anything on this Mac's screen (Touch ID, a keychain access
// prompt, an Automation or Accessibility prompt, a browser tab, the Capsule). Never under tests,
// never for a home that is not the person's own ~/.vyre, and never when a script that runs a
// real vyred unattended says so. A dialog nobody is there to answer is at best a stuck process
// and at worst a click-through by whoever sits down next.
//
//   - VYRE_NO_DIALOGS=1: never, in or out of tests.
//   - under node --test (NODE_TEST_CONTEXT): never, unless VYRE_TEST_DIALOGS=1 (a person at the
//     machine running one test on purpose). A vyred or CLI a test spawns inherits
//     NODE_TEST_CONTEXT, so this covers them too.
//   - VYRE_HOME set to anything but ~/.vyre (a dev world, a demo, a stress run): never. Those
//     homes are thrown away, and a prompt from one looks exactly like one from the real install.
//     A person who keeps Vyre in a custom home on purpose sets VYRE_ALLOW_DIALOGS=1. It never
//     applies under tests, and VYRE_NO_DIALOGS still wins.
//   - otherwise: yes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The one home that belongs to a person: ~/.vyre, against the account's home folder from the
 * user database rather than $HOME, so a script that points HOME at a temp folder (release-check,
 * a test) does not look like the real install.
 */
export function realHome() {
  let dir = os.homedir();
  try { dir = os.userInfo().homedir || dir; } catch {}
  return path.join(dir, ".vyre");
}

/** Whether `root` is ~/.vyre. @param {string} root */
export function isRealHome(root) {
  return path.resolve(String(root).replace(/^~(?=$|\/)/, os.homedir())) === realHome();
}

/**
 * Claude Code's folder (sessions, transcripts, settings, CLAUDE.md, skills) for the Vyre home at
 * `root`. The person's real one (CLAUDE_CONFIG_DIR, else ~/.claude) only for their own ~/.vyre;
 * any other home (a dev world, a demo, a temp home, a test) gets `<root>/claude`, empty until
 * something puts a fixture there, so it never reads or writes the person's conversations.
 * VYRE_CLAUDE_HOME names the folder outright, for a home kept elsewhere on purpose.
 * @param {string} root @param {NodeJS.ProcessEnv} [env]
 */
export function claudeHome(root, env = process.env) {
  if (env.VYRE_CLAUDE_HOME) return path.resolve(env.VYRE_CLAUDE_HOME.replace(/^~(?=$|\/)/, os.homedir()));
  if (isRealHome(root)) return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), ".claude");
  return path.join(path.resolve(String(root)), "claude");
}

/**
 * Claude Code's `.claude.json` (MCP servers at user and local scope, onboarding state) for the
 * Vyre home at `root`. Ordinarily it sits beside `~/.claude`, not inside it, so this is its own
 * function rather than a path built from claudeHome(); but when CLAUDE_CONFIG_DIR is set, Claude
 * Code itself moves `.claude.json` inside that folder (not beside it), so this follows suit for
 * the person's real ~/.vyre. Any other home (a dev world, a demo, a temp home, a test) gets
 * `<root>/claude.json`, empty until a fixture puts one there, the same rule claudeHome follows for
 * the folder next to it (e2e review, 2026-09-28, after discover.js read os.homedir() directly;
 * corrected 2026-09-28, e2e LOW: CLAUDE_CONFIG_DIR does move .claude.json too).
 * @param {string} root @param {NodeJS.ProcessEnv} [env]
 */
export function claudeJson(root, env = process.env) {
  if (env.VYRE_CLAUDE_HOME) return path.join(path.dirname(path.resolve(env.VYRE_CLAUDE_HOME.replace(/^~(?=$|\/)/, os.homedir()))), ".claude.json");
  if (isRealHome(root)) {
    if (env.CLAUDE_CONFIG_DIR) return path.join(path.resolve(env.CLAUDE_CONFIG_DIR.replace(/^~(?=$|\/)/, os.homedir())), ".claude.json");
    return path.join(os.homedir(), ".claude.json");
  }
  return path.join(path.resolve(String(root)), "claude.json");
}

const untilde = (/** @type {string} */ p) => String(p).replace(/^~(?=$|\/)/, os.homedir());

/**
 * A path with its symlinks resolved as far as it exists: the deepest existing folder's real path,
 * and the rest as written. So a link to ~/.claude, or a ~/.claude that is itself a link, compares
 * as where it really is.
 * @param {string} p
 */
function realish(p) {
  let head = path.resolve(untilde(p)), tail = "";
  for (;;) {
    try { return path.join(fs.realpathSync(head), tail); } catch {}
    const up = path.dirname(head);
    if (up === head) return path.resolve(untilde(p));
    tail = path.join(path.basename(head), tail);
    head = up;
  }
}

/** Is `p` the folder `dir` or inside it, by the paths as written or as they really are? */
const within = (/** @type {string} */ p, /** @type {string} */ dir) => {
  const ps = [path.resolve(untilde(p)), realish(p)], ds = [path.resolve(untilde(dir)), realish(dir)];
  return ps.some(a => ds.some(d => a === d || a.startsWith(d + path.sep)));
};

/**
 * The transcript folders a Vyre home may read. The person's own Claude Code folder (~/.claude, or
 * CLAUDE_CONFIG_DIR) is read only by their own ~/.vyre: a dev world, a demo, a trial or a temp home
 * indexing every real conversation on the machine is how a trial Capsule once answered from the
 * person's dev sessions. Such a home keeps its own folders (claudeHome(root)) and anything outside
 * the person's, or the real one when VYRE_ALLOW_REAL_TRANSCRIPTS=1 says so on purpose. Under
 * node --test the real one is never read, whatever the config or the environment says. Symlinks
 * are followed both ways. Recall and the Switchboard both read through this.
 * @param {string[]} folders @param {string} [root] the Vyre home @param {NodeJS.ProcessEnv} [env]
 */
export function transcriptFolders(folders, root = "", env = process.env) {
  const theirs = [path.join(os.homedir(), ".claude"), ...(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : [])];
  const personal = (/** @type {string} */ f) => theirs.some(d => within(f, d));
  if (env.NODE_TEST_CONTEXT) return folders.filter(f => !personal(f));
  if (root && isRealHome(root)) return folders;
  if (env.VYRE_ALLOW_REAL_TRANSCRIPTS === "1") return folders;
  const own = root ? claudeHome(root, env) : null;
  return folders.filter(f => !personal(f) || Boolean(own && within(f, own)));
}

/** @param {NodeJS.ProcessEnv} [env] */
export function dialogsAllowed(env = process.env) {
  if (env.VYRE_NO_DIALOGS === "1") return false;
  if (env.NODE_TEST_CONTEXT) return env.VYRE_TEST_DIALOGS === "1";
  if (env.VYRE_HOME && !isRealHome(env.VYRE_HOME)) return env.VYRE_ALLOW_DIALOGS === "1";
  return true;
}

/**
 * Whether a vyred on `root` may look for, or pair with, a box on the real tailnet. The same rule
 * as dialogs: a dev world, a demo or a stress run on a temp home found the user's live box and
 * sent it a real pairing request. Only ~/.vyre may, or a home whose owner says so with
 * VYRE_ALLOW_REAL_BOX=1. VYRE_ALLOW_DIALOGS=1 is about dialogs, not boxes: a trial home that
 * allowed dialogs and named the user's box sent it a pairing request. VYRE_NO_DIALOGS does not
 * change it either: a stress run sets that and still must not pair.
 * @param {string} root @param {NodeJS.ProcessEnv} [env]
 */
export function realBoxAllowed(root, env = process.env) {
  if (env.VYRE_ALLOW_REAL_BOX === "1") return true;
  if (env.NODE_TEST_CONTEXT) return false;
  return isRealHome(root);
}

/** The error code a refused dialog carries. */
export const NO_DIALOG = "no_dialog";
