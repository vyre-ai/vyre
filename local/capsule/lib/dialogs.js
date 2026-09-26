// @ts-check
// dialogs: the Capsule's copy of core/config/dialogs.js (the packaged app carries only
// local/capsule, so it cannot import core). Keep the two rules the same: nothing reaches the
// screen under node --test unless VYRE_TEST_DIALOGS=1, and never with VYRE_NO_DIALOGS=1.
import { execFile } from "node:child_process";

/** @param {NodeJS.ProcessEnv} [env] */
export function dialogsAllowed(env = process.env) {
  if (env.VYRE_NO_DIALOGS === "1") return false;
  if (env.NODE_TEST_CONTEXT && env.VYRE_TEST_DIALOGS !== "1") return false;
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
