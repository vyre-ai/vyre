// @ts-check
// [reviewed: trust] Kernel egress for a secret-tagged value. The tag is the field type (lib/secret-schema.js),
// so the tool's name does not decide it. An assistant, model, MCP or hosted caller never receives one.
// A person's own caller is unchanged, so a recovery key can still be shown once. Lending (vault.request,
// vault.space.use) injects the value and still drops a secret-tagged field inside the vendor body.
import { collectSecrets, popSecretScope, pushSecretScope, redactLog, redactSecrets, rememberSecrets } from "../../lib/secret-schema.js";

export { redactLog };

const AGENT_OR_THREAD = /(?:^|[\s:])(?:agent|thread):/;
const LENDING = new Set(["vault.request", "vault.space.use"]);

/** @param {string} caller */
const kindOf = (caller) => String(caller || "").replace(/[\s:](agent|thread):.*$/s, "");

/**
 * An MCP or harness caller, including a bare "mcp" and a session thread. A module is never one.
 * A person on the terminal ("cli") is not one; an agent riding that label is.
 * @param {string} caller
 */
export function modelCaller(caller) {
  const c = String(caller || "");
  if (c.startsWith("module:")) return false;
  const kind = kindOf(c);
  return kind === "mcp" || kind === "harness" || kind === "hosted" || AGENT_OR_THREAD.test(c);
}

/** In-the-air lending. The value is injected and does not come back as the result. @param {string} name */
export function lending(name) {
  return LENDING.has(String(name || ""));
}

/**
 * Take secret-tagged values out of a result an assistant, model, MCP or hosted caller will see.
 * A person's own caller is unchanged.
 * [reviewed: trust]
 * @param {string} caller @param {string} tool @param {any} result @param {any} [input] @param {any} [def]
 */
export function scrubVaultResult(caller, tool, result, input, def) {
  if (!modelCaller(caller) || result == null || typeof result !== "object") return result;
  const secrets = collectSecrets(input, def && def.input);
  rememberSecrets(secrets);
  const stripVaultValue = !lending(tool) && String(tool || "").startsWith("vault.");
  return redactSecrets(result, { secrets, schema: def && (def.output || def.input), stripVaultValue }).value;
}

/**
 * Remember this call's secret-tagged input for the events, log lines and stream frames it emits.
 * A caller that is not an agent is left alone. Returns the scope to restore, or null when nothing was armed.
 * @param {string} caller @param {any} input @param {any} def @param {any} meta
 */
export function armSecrets(caller, input, def, meta) {
  if (!modelCaller(caller)) return null;
  const secrets = collectSecrets(input, def && def.input);
  const prev = pushSecretScope(secrets);
  if (meta && typeof meta.partial === "function") {
    const raw = meta.partial;
    meta.partial = (/** @type {any} */ frame) => raw(typeof frame === "string" ? redactLog(frame) : redactSecrets(frame, { secrets }).value);
  }
  return { prev };
}

/** Put back the scope an agent call replaced. `armed` is what armSecrets returned. @param {any} armed */
export function disarmSecrets(armed) {
  if (!armed) return;
  popSecretScope(armed.prev);
}
