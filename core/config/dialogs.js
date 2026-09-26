// @ts-check
// dialogs: whether Vyre may raise anything on this Mac's screen (Touch ID, a keychain access
// prompt, an Automation or Accessibility prompt, a browser tab, the Capsule). Never under tests,
// and never when a script that runs a real vyred unattended says so. A dialog nobody is there to
// answer is at best a stuck process and at worst a click-through by whoever sits down next.
//
//   - VYRE_NO_DIALOGS=1: never, in or out of tests.
//   - under node --test (NODE_TEST_CONTEXT): never, unless VYRE_TEST_DIALOGS=1 (a person at the
//     machine running one test on purpose). A vyred or CLI a test spawns inherits
//     NODE_TEST_CONTEXT, so this covers them too.
//   - otherwise: yes.

/** @param {NodeJS.ProcessEnv} [env] */
export function dialogsAllowed(env = process.env) {
  if (env.VYRE_NO_DIALOGS === "1") return false;
  if (env.NODE_TEST_CONTEXT && env.VYRE_TEST_DIALOGS !== "1") return false;
  return true;
}

/** The error code a refused dialog carries. */
export const NO_DIALOG = "no_dialog";
