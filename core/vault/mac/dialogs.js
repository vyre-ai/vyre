// @ts-check
// dialogs: the vault's own gate on its Swift helpers. Whether a dialog may show at all is
// core/config/dialogs.js, shared with presence, the CLI and the Capsule.

export { dialogsAllowed } from "../../config/dialogs.js";
import { dialogsAllowed } from "../../config/dialogs.js";

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
