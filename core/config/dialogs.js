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
 * VYRE_ALLOW_DIALOGS=1 or VYRE_ALLOW_REAL_BOX=1. VYRE_NO_DIALOGS does not change it: a stress run
 * sets that and still must not pair.
 * @param {string} root @param {NodeJS.ProcessEnv} [env]
 */
export function realBoxAllowed(root, env = process.env) {
  if (env.VYRE_ALLOW_REAL_BOX === "1") return true;
  if (env.NODE_TEST_CONTEXT) return false;
  return isRealHome(root) || env.VYRE_ALLOW_DIALOGS === "1";
}

/** The error code a refused dialog carries. */
export const NO_DIALOG = "no_dialog";
