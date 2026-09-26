// @ts-check
// dialogs: whether vyred may raise a system dialog (Touch ID, a keychain access prompt, an
// Automation prompt) on this Mac. Never under tests, and never when a script that runs a real
// vyred unattended says so. A dialog nobody is there to answer is at best a stuck process and
// at worst a click-through by whoever sits down next.
//
//   - VYRE_NO_DIALOGS=1: never, in or out of tests.
//   - under node --test (NODE_TEST_CONTEXT): never, unless VYRE_TEST_DIALOGS=1 (a person at the
//     machine running one test on purpose).
//   - otherwise: yes.

/** @param {NodeJS.ProcessEnv} [env] */
export function dialogsAllowed(env = process.env) {
  if (env.VYRE_NO_DIALOGS === "1") return false;
  if (env.NODE_TEST_CONTEXT && env.VYRE_TEST_DIALOGS !== "1") return false;
  return true;
}

export const NO_DIALOGS = "dialogs are off under tests";

/**
 * Throw before a real helper runs something that can raise a dialog, when dialogs are off.
 * Test fakes (`command` set) are never real, so they always run.
 *   - enclave: `auth` and `derive` evaluate Touch ID. `create` and `available` do not.
 *   - type: its AppleScript to a browser can raise the Automation prompt, so it never runs.
 *   - keychain: only with `noUI: true`, which turns user interaction off in the helper.
 * @param {string} name @param {any} [request] @param {NodeJS.ProcessEnv} [env]
 */
export function checkDialog(name, request, env = process.env) {
  if (dialogsAllowed(env)) return;
  const op = request && request.op;
  const refuse = () => { throw Object.assign(new Error(NO_DIALOGS), { code: "presence_required" }); };
  if (name === "enclave" && (op === "auth" || op === "derive")) refuse();
  if (name === "type") refuse();
  if (name === "keychain" && !(request && request.noUI === true)) refuse();
}
