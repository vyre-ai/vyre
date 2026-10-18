// @ts-check
// The Flow runner's faults and the one showable helper: the error kinds a step, a pause and a hold are thrown as, the way a port's
// failure becomes a step's code, and the timeline's cut of an input. Moved out of runner.js unchanged (its file-size cap); the runner
// imports them, and still re-exports showable so nothing that imports it changes.
import { redact as redactText } from "../../lib/credential-shapes.js";
import { hiddenField } from "../../lib/secret-keys.js";

export { Suspend, StepFail, Hold, PauseFlow, portFail, failOf };

class Suspend extends Error { constructor() { super("suspended"); this.name = "Suspend"; } }
class StepFail extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "StepFail"; this.code = code; }
}
/** A port's own failure (the sandbox's timeout, the door's refusal) keeps its code as the step's. @param {any} e @returns {never} */
function portFail(e) {
  if (e instanceof StepFail || e instanceof Suspend || e instanceof PauseFlow || !e || typeof e.code !== "string") throw e;
  throw new StepFail(e.code, e instanceof Error ? e.message : String(e));
}
/** What went wrong, as a code and words, whatever was thrown. A port's own code is kept; the usual network faults get the names a retry policy knows. @param {any} e @returns {{ code: string, message: string }} */
function failOf(e) {
  if (e instanceof StepFail) return { code: e.code, message: e.message };
  const raw = e && typeof e.code === "string" ? e.code : "error";
  const code = /^(ETIMEDOUT|ESOCKETTIMEDOUT)$/.test(raw) ? "timeout" : /^(ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN)$/.test(raw) ? "connection_reset" : raw;
  return { code, message: e instanceof Error ? e.message : String(e) };
}
/**
 * An input as the timeline may show it: credential-shaped strings and the values of keys that name a secret are hidden, a sealed value shows only that it is sealed, and the whole is cut to `cap` bytes (2 KB by default).
 * @param {any} v @param {number} [cap] @returns {any}
 */
export function showable(v, cap = 2048) {
  if (v === undefined) return undefined;
  const walk = (/** @type {any} */ x, /** @type {number} */ depth) => {
    if (depth > 6) return "\u2026";
    if (x !== null && typeof x === "object" && !Array.isArray(x) && Object.hasOwn(x, "sealed")) return { sealed: true };   // a sealed value is never kept, only that there was one
    if (typeof x === "string") return redactText(x);
    if (Array.isArray(x)) return x.slice(0, 50).map(y => walk(y, depth + 1));
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).slice(0, 50).map(([k, y]) => [k, hiddenField(k, y) ? "[hidden]" : walk(y, depth + 1)]));
    return x;
  };
  const out = walk(v, 0);
  const text = JSON.stringify(out) ?? "null";
  return text.length > cap ? { cut: true, head: text.slice(0, cap - 48) } : out;
}

/** The run stops at the next step boundary because the Space's switch says pause: it is held (state queued) and goes on, in order, when the switch is released. */
class Hold extends Error {
  /** @param {string} reason */
  constructor(reason) { super(reason); this.name = "Hold"; this.reason = reason; }
}
class PauseFlow extends Error {
  /** @param {string} reason */
  constructor(reason) { super(reason); this.name = "PauseFlow"; this.reason = reason; }
}
