// @ts-check
// The module contract version (ADR 0047 section 8): which contract a module names in its
// `"vyre"` key, which ones this Vyre supports, and the plain line a person reads when a module
// needs a newer one. contract.json maps each contract minor to the first Vyre release that speaks
// it, and lists the supported majors.
//
// A module that names a contract this Vyre doesn't support is never imported: the loader marks it
// invalid with supports()'s message, and `vyre module add` and `vyre module check` say the same.

import fs from "node:fs";
import * as v1 from "./compat/v1.js";

/** @typedef {{ current: string, supported: string[], versions: Record<string, string> }} Contract */

/** @type {Contract} */
export const CONTRACT = JSON.parse(fs.readFileSync(new URL("./contract.json", import.meta.url), "utf8"));

/** The adapters by major (compat/). Each supported major has one. */
const ADAPTERS = { 1: v1 };

/**
 * "1" or "1.2" as numbers, or null when it isn't a contract version.
 * @param {unknown} v @returns {{ major: number, minor: number, text: string } | null}
 */
export function parseContract(v) {
  const x = typeof v === "string" ? /^(\d+)(?:\.(\d+))?$/.exec(v.trim()) : null;
  return x ? { major: Number(x[1]), minor: Number(x[2] || 0), text: v.trim() } : null;
}

/**
 * The contract a manifest names: "vyre", else a deprecated apiVersion read as its major, else "1"
 * for a module shipped with Vyre (and, at load, for any module that names none). null when it
 * names nothing and none is assumed.
 * @param {any} m @param {{ assume?: boolean }} [o]
 * @returns {string | null}
 */
export function moduleContract(m, { assume = true } = {}) {
  if (m && typeof m.vyre === "string") return m.vyre;
  if (m && Number.isInteger(m.apiVersion)) return String(m.apiVersion);
  return assume ? "1" : null;
}

/** The newest minor of a major that a contract knows, as "M.m", or null. @param {Contract} c @param {number} major */
export function newestOf(c, major) {
  const minors = Object.keys(c.versions).map(parseContract).filter(v => v && v.major === major).map(v => /** @type {any} */ (v).minor);
  if (!minors.length) return c.supported.includes(String(major)) ? `${major}.0` : null;
  return `${major}.${Math.max(...minors)}`;
}

/**
 * Whether this Vyre speaks the contract a module names.
 * @param {unknown} vyre the module's "vyre" value
 * @param {{ name?: string, contract?: Contract | string }} [o] contract: another contract, or a
 *   version to test against (the compat test runs every supported version)
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function supports(vyre, { name = "this module", contract = CONTRACT } = {}) {
  const c = typeof contract === "string" ? { ...CONTRACT, current: contract } : contract;
  const want = parseContract(vyre);
  if (!want) return { ok: false, message: `${name}: "vyre" must be a contract version like "1" or "1.2", not ${JSON.stringify(vyre)}` };
  const current = /** @type {{ major: number, minor: number }} */ (parseContract(c.current));
  const release = c.versions[`${want.major}.${want.minor}`];
  const newer = release ? `Vyre ${release.replace(/\.0$/, "")} or later` : "a newer Vyre";
  if (!c.supported.includes(String(want.major))) {
    if (want.major > current.major) return { ok: false, message: `${name} needs ${newer} (module contract ${want.text}); this Vyre has ${c.current}. Update Vyre, or ask the module's author for a version for contract ${current.major}.` };
    return { ok: false, message: `${name} is written for module contract ${want.major}, which this Vyre no longer supports (it has ${c.current}). Run vyre module upgrade on its folder, or ask its author for a newer version.` };
  }
  // The newest minor this Vyre speaks in that major: the current one in its own major.
  const top = want.major === current.major ? current.minor : Number((newestOf(c, want.major) || "0.0").split(".")[1]);
  if (want.minor > top) return { ok: false, message: `${name} needs ${newer} (module contract ${want.text}); this Vyre has ${c.current}. Update Vyre, or ask the module's author for an older version.` };
  return { ok: true };
}

/**
 * The adapter for a supported contract (compat/v<major>.js): the loader and the harness give the
 * module its manifest and ctx through it.
 * @param {unknown} vyre
 */
export function adapterFor(vyre) {
  const v = parseContract(vyre);
  const a = v && /** @type {Record<number, typeof v1>} */ (ADAPTERS)[v.major];
  if (!a) throw new Error(`no adapter for module contract ${String(vyre)}`);
  return a;
}
