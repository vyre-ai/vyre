// @ts-check
// run: call a learned operation once, whichever rung carries it. The rung supplies `send` (a fetch inside the person's own page, a plain fetch for a public op, a fetch inside the box's
// signed-in browser, the Mac's Chrome asked over the link); this file does everything else the same way every time: check the inputs, resolve credential references where the request is
// signed, hold what goes out, send exactly once, classify the answer, extract and cap it, and say what to do next.
//
// Rules that live here and nowhere else:
//   - inputs are checked before anything is built; a bad input never reaches the network;
//   - an operation that is not a read goes through `gate` first, and is sent only when the gate lets it pass;
//   - a write is sent AT MOST ONCE. If the send fails after the request may have left, the result says the outcome is unknown and does not retry; only a caller that knows better may;
//   - the answer is classified (classify.js) and cut to a cap; nothing but the extracted data returns, never a header or a cookie.

import { buildRequest, refsOf } from "./build.js";
import { judge, nextStep } from "./classify.js";
import { capOutput } from "./extract.js";
import { readOnly } from "./spec.js";

/**
 * @typedef {object} RunDeps
 * @property {(req: { method: string, url: string, headers: Record<string, string>, body?: string }) => Promise<{ status: number, headers: Record<string, string>, body: string, url?: string, redirected?: boolean }>} send
 * @property {(ref: string) => string|undefined|Promise<string|undefined>} [resolveRef] page-side only
 * @property {(built: any, op: any) => any} [gate] returns a held answer (an object with held: true) to stop before sending, or null to go on
 * @property {{ html?: Function, emptyResults?: Function }} [readers]
 * @property {number} [maxChars]
 */

/**
 * @param {any} op @param {Record<string, any>} inputs @param {RunDeps} deps
 * @returns {Promise<{ ok: boolean, class: string, data?: any, truncated?: string, status?: number, reason?: string, next?: string, held?: any, executed: boolean, ambiguous?: boolean, missingRefs?: string[], version?: number }>}
 */
export async function runOperation(op, inputs, deps) {
  const ro = readOnly(op);
  // 1. refs: resolve every credential reference where the request is signed; the values stay in this closure
  /** @type {Record<string, string>} */ const have = {};
  const missingRefs = [];
  for (const ref of refsOf(op)) {
    const v = deps.resolveRef ? await deps.resolveRef(ref) : undefined;
    if (typeof v === "string" && v) have[ref] = v; else missingRefs.push(ref);
  }
  // 2. build (this is where a bad input is refused, before the network)
  /** @type {ReturnType<typeof buildRequest>} */ let built;
  try { built = buildRequest(op, inputs, ref => have[ref]); }
  catch (e) {
    const x = /** @type {any} */ (e);
    return { ok: false, class: x.code === "input" ? "input" : "error", reason: String(x.message || e), next: nextStep(x.code === "input" ? "input" : "error", op), executed: false };
  }
  // 3. the gate: anything that is not a read waits unless the caller's approval says go
  if (deps.gate) {
    const held = deps.gate(built, op);
    if (held) return { ok: false, class: "held", held, executed: false, reason: "waiting for a yes" };
  }
  // 4. send once
  /** @type {Awaited<ReturnType<RunDeps["send"]>>} */ let res;
  try { res = await deps.send(built); }
  catch (e) {
    const msg = String(/** @type {any} */ (e)?.message || e).split("\n")[0];
    // A read can simply be asked again. A write may have left: do not say it did not.
    return ro
      ? { ok: false, class: "error", reason: `the request did not complete: ${msg}`, next: nextStep("error", op), executed: false, ...(missingRefs.length ? { missingRefs } : {}) }
      : { ok: false, class: "error", reason: `the request may or may not have been made: ${msg}`, next: "the write may have gone through: check the site before any retry", executed: false, ambiguous: true };
  }
  // 5. judge
  const j = judge(op, { status: res.status, headers: lower(res.headers), body: res.body ?? "", ...(res.url ? { url: res.url } : {}) }, deps.readers);
  const cls = /** @type {any} */ (j.class);
  const ran = !ro && !(res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) || (!ro && !!res.redirected);
  if (cls === "ok") {
    const cap = capOutput(j.data, deps.maxChars);
    return { ok: true, class: "ok", data: cap.data, ...(cap.truncated ? { truncated: cap.truncated } : {}), status: res.status, executed: !ro, ...(j.reason && j.reason !== "ok" ? { reason: j.reason } : {}), version: op.version };
  }
  return { ok: false, class: cls, status: res.status, reason: j.reason, next: nextStep(cls, op, { reason: j.reason, ran }), executed: !ro && ran, ...(!ro && ran && cls !== "auth" && cls !== "drift" ? { ambiguous: true } : {}), ...(missingRefs.length ? { missingRefs } : {}) };
}

/** @param {Record<string, string>} h */
function lower(h) { /** @type {Record<string, string>} */ const o = {}; for (const [k, v] of Object.entries(h || {})) o[k.toLowerCase()] = String(v); return o; }
