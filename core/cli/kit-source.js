// @ts-check
// kit-source: reading a Kit from where a person says it is.
//
// A file is read from this computer. An https address is fetched from here too, so the Kit never
// travels through vyred and a token for a private address stays on this computer. The fetch is an
// argument, so a test reads a Kit without a network.
//
// Nothing here keeps a value: the Kit is handed on as it was read, and the token of a private
// address is used for the one request and then forgotten.

import fs from "node:fs";
import path from "node:path";
import { checkSource } from "../../lib/kit-source.js";
import { userHostFetch } from "../../lib/http.js";
import { parseRef } from "../vault/refs.js";
import { callAsPerson } from "./presence.js";

/** How large a Kit may be. */
export const MAX_KIT_BYTES = 1024 * 1024;

/**
 * Whether a word names a Kit to install from a file or an address, rather than one of the Kits
 * this build ships. A word with no path in it and no .json at the end is a Kit of the library.
 * @param {string} text
 */
export function looksLikeSource(text) {
  const s = String(text || "");
  return s.startsWith("https://") || s.includes("/") || s.includes("\\") || s.startsWith(".") || s.startsWith("~") || s.endsWith(".json");
}

/**
 * Read the Kit a source names.
 * @param {string} text the file path or the https address
 * @param {{ fetch?: (url: string, init?: any) => Promise<any>, token?: () => Promise<any> }} [opts]
 *   `token` is asked for only when the source is an address: it hands back { ok: true, value } or
 *   { ok: false, why, code }. The value is used for that one request and is never kept.
 * @returns {Promise<{ ok: true, kit: any, source: string, kind: "file" | "url" } | { ok: false, why: string, code?: string }>}
 */
export async function readKit(text, { fetch = userHostFetch, token } = {}) {
  const checked = checkSource(text);
  if (!checked.ok) return { ok: false, why: checked.why, code: "bad_input" };
  if (checked.kind === "url") return readFromUrl(checked.source, { fetch, token });
  return readFromFile(checked.source);
}

/**
 * The Kit in a file on this computer.
 * @param {string} source
 * @returns {{ ok: true, kit: any, source: string, kind: "file" } | { ok: false, why: string, code?: string }}
 */
function readFromFile(source) {
  const file = path.resolve(source);
  let stat;
  try { stat = fs.statSync(file); }
  catch { return { ok: false, why: `there is no Kit at ${file}: check the path`, code: "not_found" }; }
  if (!stat.isFile()) return { ok: false, why: `${file} is not a file: give the file the Kit is in`, code: "bad_input" };
  if (stat.size > MAX_KIT_BYTES) return { ok: false, why: `${file} is larger than a Kit may be: give a smaller file`, code: "too_large" };
  let text2 = "";
  try { text2 = fs.readFileSync(file, "utf8"); }
  catch (e) { return { ok: false, why: `cannot read ${file}: ${/** @type {Error} */ (e).message}`, code: "failed" }; }
  const kit = parseKit(text2, file);
  if (!kit.ok) return kit;
  return { ok: true, kit: kit.kit, source: file, kind: "file" };
}

/**
 * The Kit at an https address, fetched from this computer.
 * @param {string} url
 * @param {{ fetch: (url: string, init?: any) => Promise<any>, token?: () => Promise<any> }} o
 * @returns {Promise<{ ok: true, kit: any, source: string, kind: "url" } | { ok: false, why: string, code?: string }>}
 */
async function readFromUrl(url, { fetch, token }) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (token) {
    const v = await token();
    if (!v || v.ok !== true) return { ok: false, why: String((v && v.why) || "the token could not be read"), code: String((v && v.code) || "failed") };
    // The token goes in the request's own header, for this one request: it is not printed, not stored and never written into the Kit.
    headers.authorization = `Bearer ${v.value}`;
  }
  let res;
  try { res = await fetch(url, { headers, timeoutMs: 30_000, maxBytes: MAX_KIT_BYTES }); }
  catch (e) { return { ok: false, why: `cannot reach ${url}: ${/** @type {Error} */ (e).message}`, code: "unreachable" }; }
  const good = Boolean(res) && (res.ok !== undefined ? Boolean(res.ok) : Number(res.status) >= 200 && Number(res.status) < 300);
  if (!good) {
    const status = res && res.status ? Number(res.status) : 0;
    if (status === 401 || status === 403) return { ok: false, why: `${url} answered ${status}: it wants a token. Give one with --token vault://item/field`, code: "not_found" };
    return { ok: false, why: `${url} answered ${status || "with nothing"}: give an address that serves the Kit`, code: "not_found" };
  }
  let text2 = "";
  try { text2 = await res.text(); }
  catch (e) { return { ok: false, why: `cannot read the Kit at ${url}: ${/** @type {Error} */ (e).message}`, code: "failed" }; }
  const kit = parseKit(text2, url);
  if (!kit.ok) return kit;
  return { ok: true, kit: kit.kit, source: url, kind: "url" };
}

/**
 * The Kit in a piece of text, or the words to say why it is not one.
 * @param {string} text @param {string} where
 * @returns {{ ok: true, kit: any } | { ok: false, why: string, code?: string }}
 */
function parseKit(text, where) {
  let kit;
  try { kit = JSON.parse(text); }
  catch { return { ok: false, why: `${where} is not JSON: give the file that holds the Kit`, code: "bad_input" }; }
  if (!kit || typeof kit !== "object" || Array.isArray(kit)) return { ok: false, why: `${where} does not hold a Kit: give the file that holds one`, code: "bad_input" };
  return { ok: true, kit };
}

/**
 * The reference a token is named by, or the words to say why it is not one. The reference itself is
 * not a secret and may be on the command line; the value behind it is never touched here.
 * @param {string} text
 * @returns {{ ok: true, ref: string } | { ok: false, why: string }}
 */
export function tokenRef(text) {
  try { return { ok: true, ref: parseRef(text).ref }; }
  catch (e) { return { ok: false, why: `${/** @type {Error} */ (e).message}: give it as vault://item/field` }; }
}

/**
 * The value of a vault reference, for one request. It is never printed, never stored and never
 * written into the Kit.
 * @param {string} ref a vault://item/field reference
 * @param {{ resolve?: (ref: string) => Promise<any> }} [opts]
 * @returns {Promise<{ ok: true, value: string } | { ok: false, why: string, code?: string }>}
 */
export async function vaultToken(ref, { resolve = defaultResolve } = {}) {
  const parsed = tokenRef(ref);
  if (!parsed.ok) return { ok: false, why: parsed.why, code: "bad_input" };
  const r = await resolve(parsed.ref);
  if (!r || r.error) {
    const error = (r && r.error) || {};
    return { ok: false, why: String(error.message || error.code || "the vault did not answer"), code: String(error.code || "failed") };
  }
  const values = (r.data && r.data.values) || {};
  const value = values[parsed.ref] !== undefined ? values[parsed.ref] : Object.values(values)[0];
  if (typeof value !== "string" || !value) return { ok: false, why: `the vault has no value at ${parsed.ref}: check the reference`, code: "not_found" };
  return { ok: true, value };
}

/**
 * The Vault's own way to hand a value over: through vyred, with the person's yes.
 * @param {string} ref
 */
async function defaultResolve(ref) {
  return await callAsPerson("vault.resolve", { refs: [ref], destination: "the Kit download" });
}
