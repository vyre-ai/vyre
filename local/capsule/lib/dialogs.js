// @ts-check
// dialogs: the Capsule's copy of core/config/dialogs.js (the packaged app carries only
// local/capsule, so it cannot import core). Keep the two rules the same: nothing reaches the
// screen under node --test unless VYRE_TEST_DIALOGS=1, never with VYRE_NO_DIALOGS=1, and never
// for a VYRE_HOME other than ~/.vyre unless VYRE_ALLOW_DIALOGS=1.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** @param {NodeJS.ProcessEnv} [env] */
export function dialogsAllowed(env = process.env) {
  if (env.VYRE_NO_DIALOGS === "1") return false;
  if (env.NODE_TEST_CONTEXT) return env.VYRE_TEST_DIALOGS === "1";
  const home = env.VYRE_HOME && path.resolve(env.VYRE_HOME.replace(/^~(?=$|\/)/, os.homedir()));
  let mine = os.homedir();
  try { mine = os.userInfo().homedir || mine; } catch {}
  if (home && home !== path.join(mine, ".vyre")) return env.VYRE_ALLOW_DIALOGS === "1";
  return true;
}

/**
 * `run` as given, except the real execFile, which under tests fails instead of opening anything.
 * @template {Function} F @param {F} run @returns {F}
 */
export function guarded(run) {
  if (run !== execFile) return run;
  return /** @type {any} */ ((/** @type {string} */ file, /** @type {string[]} */ args, /** @type {Function} */ cb) =>
    dialogsAllowed() ? execFile(file, args, /** @type {any} */ (cb)) : cb(new Error("dialogs are off under tests")));
}
