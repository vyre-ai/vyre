// @ts-check
// Test helpers for the trust split: approvals (asked, writeOk, release, writeBudget) travel beside the args, never inside them. A test that writes
// them in the args object of a call gets them moved into the trust the host would have set.
import { dispatch } from "../extension/caps/index.js";

const KEYS = ["asked", "writeOk", "release", "writeBudget"];
/** @param {any} args @returns {[any, any]} */
export function split(args) {
  const rest = { ...(args || {}) }; /** @type {any} */ const trust = {};
  for (const k of KEYS) if (k in rest) { trust[k] = rest[k]; delete rest[k]; }
  return [rest, trust];
}
/** dispatch() with the approvals lifted out of the args. @param {string} op @param {any} args @param {any} ctx */
export function dispatchT(op, args, ctx) { const [a, t] = split(args); return dispatch(op, a, ctx, t); }
/** An op handler called directly, approvals lifted out. @param {(args: any, ctx: any, trust?: any) => any} fn */
export const T = fn => (/** @type {any} */ args, /** @type {any} */ ctx) => { const [a, t] = split(args); return fn(a, ctx, t); };
