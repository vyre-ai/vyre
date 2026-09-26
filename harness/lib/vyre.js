// @ts-check
// Where Vyre is, for a Harness that may have been copied away from it.
//
// `/plugin install vyre` copies only this folder into Claude Code's plugin cache, so the hooks and
// the MCP server cannot import ../core the way they do inside the npm package. They start here
// instead: find a Vyre package, and hand over to its own hook.js or server.js, so the code that
// runs always matches the vyred it talks to. No Vyre at all means the plugin says in one line how
// to install it and otherwise does nothing. Only node built-ins, and only a few stat calls: this
// runs before every tool call.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INSTALL = "npm install -g vyre && vyre up";

/** Is `dir` a Vyre package (the npm package or a checkout of the repo)? @param {string} dir */
function isPackage(dir) {
  try {
    if (!fs.existsSync(path.join(dir, "core", "daemon", "client.js"))) return false;
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "vyre";
  } catch { return false; }
}

/**
 * The Vyre package to run. In order: VYRE_PACKAGE (tests, a user's own checkout); the folder this
 * Harness sits in, when it was loaded from the package with --plugin-dir; the `vyre` on PATH.
 * @param {string} pluginRoot @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function findPackage(pluginRoot, env = process.env) {
  if (env.VYRE_PACKAGE) return isPackage(env.VYRE_PACKAGE) ? path.resolve(env.VYRE_PACKAGE) : null;
  const parent = path.resolve(pluginRoot, "..");
  if (isPackage(parent)) return parent;
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      // bin/vyre in the package, reached through npm's symlink.
      const real = fs.realpathSync(path.join(dir, "vyre"));
      const root = path.resolve(path.dirname(real), "..");
      if (isPackage(root)) return root;
    } catch {}
  }
  return null;
}

/** Vyre's home, as core/config resolves it. @param {NodeJS.ProcessEnv} [env] */
export function homeDir(env = process.env) {
  const h = env.VYRE_HOME || path.join(os.homedir(), ".vyre");
  return path.resolve(h === "~" ? os.homedir() : h.startsWith("~/") ? path.join(os.homedir(), h.slice(2)) : h);
}

/**
 * What this machine has: "ready" (a package and a home: hand over), "setup" (a package but
 * `vyre up` never ran here), or "missing" (no Vyre).
 * @param {string} pluginRoot @param {NodeJS.ProcessEnv} [env]
 * @returns {{ state: "ready"|"setup"|"missing", root: string|null }}
 */
export function locate(pluginRoot, env = process.env) {
  const root = findPackage(pluginRoot, env);
  if (!root) return { state: "missing", root: null };
  return { state: fs.existsSync(homeDir(env)) ? "ready" : "setup", root };
}

/** The one line a session without Vyre shows. @param {"setup"|"missing"} state */
export function hint(state) {
  return state === "setup"
    ? "Vyre is installed but not set up on this machine. Run `vyre up` to start it."
    : `The Vyre plugin is on, but Vyre is not installed. Install it with: ${INSTALL}`;
}
