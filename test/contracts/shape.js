// @ts-check
// A contract test compares the SHAPE of a real answer with a fixture: the same keys and the same kinds of value, optional keys allowed to be absent.
import assert from "node:assert/strict";

/** The shape of a value: object keys with the shapes under them, an array as the shape of its first element, a scalar as its type. Optional keys the fixture shows are optional here. @param {any} v @returns {any} */
export function shapeOf(v) {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]));
  return v === null ? "null" : typeof v;
}
/** Every key of `want` is in `got` with the same shape, except keys the fixture marks optional by name. @param {any} got @param {any} want @param {string} at @param {Set<string>} optional */
function fits(got, want, at, optional) {
  if (Array.isArray(want)) { assert.ok(Array.isArray(got), `${at} is a list`); if (want.length && got.length) fits(got[0], want[0], `${at}[0]`, optional); return; }
  if (want && typeof want === "object") {
    assert.ok(got && typeof got === "object", `${at} is an object`);
    for (const k of Object.keys(want)) {
      if (!(k in got)) { assert.ok(optional.has(k), `${at}.${k} is missing`); continue; }
      // `counts` is a map from a reason code to a number: which codes appear depends on what was found
      if (k === "counts") { assert.ok(got[k] && typeof got[k] === "object", `${at}.counts is a map`); for (const n of Object.values(got[k])) assert.equal(typeof n, "number"); continue; }
      fits(got[k], want[k], `${at}.${k}`, optional);
    }
    return;
  }
  if (want === "null" || got === null) return;
  assert.equal(got === null ? "null" : typeof got, want, `${at} is a ${want}`);
}
export const OPTIONAL = new Set(["home", "conflicts", "rotate", "group", "removed", "taken", "ignored", "kv", "dismissed_until"]);
export const matches = (/** @type {any} */ got, /** @type {any} */ fixture, at = "answer") => fits(got, shapeOf(fixture), at, OPTIONAL);

