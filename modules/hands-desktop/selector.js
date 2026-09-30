// @ts-check
// selector: how the hands say "this control" in a way that survives the window moving.
//
// A tree path (/0/1/3) or a screen point is a property of one observation, not of the control:
// opening a sidebar renumbers every path after it, and resizing the window moves every point. An
// agent that remembers either remembers a mistake and clicks confidently on the wrong thing,
// which is indistinguishable from working until it is not.
//
// So a selector is a set of attributes, ranked by how much they can be trusted, and it is
// resolved against a FRESH observation every time it is used. Nothing here stores a location.

/** @typedef {import("./snapshot.js").Control} Control */
/** @typedef {{ app?: string, role?: string, identifier?: string, name?: string, container?: string, path?: string }} Selector */

/**
 * Write down what makes this control itself.
 * @param {string} app
 * @param {Control} ctl
 * @returns {Selector}
 */
export function of(app, ctl) {
  /** @type {Selector} */
  const sel = { app, role: ctl.role };
  if (ctl.identifier) sel.identifier = ctl.identifier;
  if (ctl.name) sel.name = ctl.name;
  if (ctl.container) sel.container = ctl.container;
  // Kept only as a tiebreak between siblings that are otherwise identical, never as identity.
  sel.path = ctl.path;
  return sel;
}

// How much each kind of agreement is worth. An identifier is an app's own stable handle for a
// control, so it outranks a name; a name outranks a container; a path is worth almost nothing and
// exists only to break a tie between two candidates that agree on everything else.
export const WEIGHT = { identifier: 100, name: 40, container: 10, path: 1 };

/**
 * @param {Selector} sel
 * @param {Control} ctl
 */
export function score(sel, ctl) {
  // Role is a gate, not a score. A text field is never the button you meant, however much else
  // agrees, and letting a strong name match override that is how a "Share" search lands in a
  // "Share" text field and types into it.
  if (sel.role && ctl.role !== sel.role) return -1;
  let n = 0;
  if (sel.identifier && ctl.identifier === sel.identifier) n += WEIGHT.identifier;
  if (sel.name && ctl.name === sel.name) n += WEIGHT.name;
  if (sel.container && ctl.container === sel.container) n += WEIGHT.container;
  if (sel.path && ctl.path === sel.path) n += WEIGHT.path;
  return n;
}

/**
 * Find this control in a fresh observation, and say why not when it cannot.
 *
 * No match is a real answer and the caller must treat it as one. The recovery for a selector
 * that will not resolve is to observe again or to stop with a reason. It is never to lower the
 * threshold or to take the best of a bad set: that is the difference between a system that
 * misses honestly and one that misses silently.
 *
 * @param {Selector} sel
 * @param {Control[]} candidates
 * @returns {{ control: Control } | { control: null, why: "missing"|"tied", tied?: Control[] }}
 */
export function bind(sel, candidates, { min = WEIGHT.name } = {}) {
  let best = -1;
  /** @type {Control[]} */
  let top = [];
  for (const c of candidates) {
    const n = score(sel, c);
    if (n > best) { best = n; top = [c]; }
    else if (n === best) top.push(c);
  }
  if (best < min) return { control: null, why: "missing" };
  // Two controls that agree equally well is not a resolution. Say so rather than guessing.
  if (top.length > 1) return { control: null, why: "tied", tied: top };
  return { control: top[0] };
}

/**
 * The control, or null when it is missing or tied.
 * @param {Selector} sel
 * @param {Control[]} candidates
 */
export function resolve(sel, candidates, opts = {}) {
  return bind(sel, candidates, opts).control;
}
