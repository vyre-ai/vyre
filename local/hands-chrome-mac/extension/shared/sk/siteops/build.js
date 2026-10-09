// GENERATED from lib/siteops/build.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// build: fill a learned operation with a call's inputs and give back the request to send.
//
// Ported from api-anything http.ts buildRequest (github.com/goodnight000/api-anything, MIT; see NOTICE). The original also holds a cookie jar and sends from Node; here the request is only
// BUILT. Who sends it is the rung (inside the page for the person's Chrome and the box's Chrome, plain fetch for a public op), and a credential ref is resolved by `resolveRef`, which only the
// page-side shell supplies, so a login value is read where it signs the call and never passes through this module's callers.

import { asText, fillSlotTemplate, setAt, templateRefs } from "./codec.js";

/** @param {any} p @param {any} v */
function coerce(p, v) {
  const bad = () => new Error(`input "${p.name}" must be ${p.type}, got ${JSON.stringify(v)}`);
  switch (p.type) {
    case "number":
      if (typeof v === "number" || typeof v === "bigint") return v;
      if (typeof v === "string" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) {
        if (/^-?\d+$/.test(v) && !Number.isSafeInteger(Number(v))) return BigInt(v);
        return Number(v);
      }
      throw bad();
    case "boolean":
      if (typeof v === "boolean") return v;
      if (v === "true" || v === "false") return v === "true";
      throw bad();
    case "object":
    case "array":
      if (typeof v !== "string") return v;
      try { return JSON.parse(v); } catch { throw bad(); }
    default:
      return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

/** @param {string} v @param {string|undefined} t */
function transform(v, t) {
  if (t === "strip-quotes") return v.replace(/^"|"$/g, "");
  if (t === "url-decode") { try { return decodeURIComponent(v); } catch { return v; } }
  return v;
}

/** The inputs of a call, checked against the op's declared inputs. Throws a plain sentence naming the input. @param {any} op @param {Record<string, any>} args */
export function checkInputs(op, args) {
  /** @type {Record<string, any>} */ const vals = {};
  for (const p of op.params) {
    const v = args[p.name] ?? p.default;
    if (v === undefined) {
      if (p.required) throw Object.assign(new Error(`missing required input "${p.name}"`), { code: "input" });
      continue;
    }
    try { vals[p.name] = coerce(p, v); } catch (e) { throw Object.assign(/** @type {Error} */ (e), { code: "input" }); }
    if (p.pattern !== undefined && !new RegExp(`^(?:${p.pattern})$`).test(asText(vals[p.name]))) {
      throw Object.assign(new Error(`input "${p.name}" must be ${p.hint ?? `a value matching /${p.pattern}/`}, got ${JSON.stringify(v)}`), { code: "input" });
    }
  }
  return vals;
}

/**
 * The fully materialised request: inputs and credential refs filled in.
 * @param {any} op @param {Record<string, any>} args
 * @param {(ref: string) => string|undefined} [resolveRef] page-side only; a missing one leaves every ref unresolved
 * @returns {{ method: string, url: string, headers: Record<string, string>, body?: string }}
 */
export function buildRequest(op, args, resolveRef = () => undefined) {
  const vals = checkInputs(op, args);
  /** @type {any} */
  let req = { ...op.request, method: op.request.method.toUpperCase(), headers: { ...op.request.headers } };
  delete req.headers.cookie;
  for (const slot of op.slots) {
    const name = slot.param ?? slot.ref;
    /** @type {any} */
    let v = slot.param !== undefined ? vals[slot.param] : resolveRef(slot.ref);
    if (v === undefined) {
      // A missing session value: drop the header rather than send it blank.
      const only = slot.at.length === 1 ? slot.at[0] : "";
      if (slot.ref && only.startsWith("header:")) delete req.headers[only.slice(7).toLowerCase()];
      continue;
    }
    if (slot.ref) v = transform(v, slot.transform);
    if (slot.template !== undefined) {
      // A Referer or Origin is a URL: the input goes in percent-encoded.
      const escape = slot.escape ?? (slot.param && /^header:(referer|origin)$/i.test(slot.at[0]) ? "url" : undefined);
      const refs = Object.fromEntries(templateRefs(slot.template).map(r => [r, resolveRef(r) ?? ""]));
      v = fillSlotTemplate(slot.template, { ...refs, ...vals, [name]: v }, escape);
    }
    req = setAt(req, slot.at, v);
  }
  // Header values must be bytes: a value that is not ASCII goes percent-encoded, as a browser sends a URL.
  for (const [k, h] of Object.entries(req.headers)) if (/[^\x00-\x7f]/.test(/** @type {string} */ (h))) req.headers[k] = /** @type {string} */ (h).replace(/[^\x00-\x7f]+/g, encodeURIComponent);
  return req;
}

/** The credential refs an op reads: what the page-side shell must be able to resolve. @param {any} op @returns {string[]} */
export function refsOf(op) {
  return [...new Set(op.slots.flatMap((/** @type {any} */ s) => [...(s.ref ? [s.ref] : []), ...(s.template ? templateRefs(s.template) : [])]))];
}
