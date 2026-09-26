// @ts-check
// selector: how the hands say "this control" in a way that survives the page moving.
//
// A DOM path or a screen point is a property of one observation, not of the control: a banner
// appearing renumbers every path after it, and scrolling moves every point. An agent that
// remembers either remembers a mistake and clicks confidently on the wrong thing, which looks
// exactly like working until it does not.
//
// So a selector is a set of attributes ranked by how far they can be trusted, and it is
// resolved against a FRESH snapshot every time it is used. Nothing here stores a location.
//
// Ported from the measured desktop helper this project grew out of; hands-desktop keeps its own
// copy, because modules never import each other.

/**
 * @typedef {{ role?: string, identifier?: string, name?: string, container?: string, path?: string }} Selector
 * @typedef {{ role: string, identifier?: string, name?: string, container?: string, path?: string, enabled?: boolean }} Control
 */

/**
 * Write down what makes this control itself.
 * @param {Control} ctl
 * @returns {Selector}
 */
export function of(ctl) {
  return {
    role: ctl.role,
    identifier: ctl.identifier || undefined,
    name: ctl.name || undefined,
    container: ctl.container || undefined,
    // Kept only as a tiebreak between siblings that are otherwise identical, never as identity.
    path: ctl.path,
  };
}

// An identifier is the page's own stable handle for a control, so it outranks a name; a name
// outranks a container; a path is worth almost nothing and only breaks a tie.
export const WEIGHT = { identifier: 100, name: 40, container: 10, path: 1 };

/**
 * @param {Selector} sel
 * @param {Control} ctl
 */
export function score(sel, ctl) {
  // Role is a gate, not a score. A text field is never the button you meant however much else
  // agrees; letting a strong name override that is how a "Search" button search lands in a
  // "Search" field and types into it.
  if (sel.role && ctl.role !== sel.role) return -1;
  let n = 0;
  if (sel.identifier && ctl.identifier === sel.identifier) n += WEIGHT.identifier;
  if (sel.name && ctl.name === sel.name) n += WEIGHT.name;
  if (sel.container && ctl.container === sel.container) n += WEIGHT.container;
  if (sel.path && ctl.path === sel.path) n += WEIGHT.path;
  return n;
}

/**
 * Find this control in a fresh snapshot. Returns `{ control }` or `{ control: null, why }`.
 *
 * No match is a real answer and the caller must treat it as one: look again or stop with a
 * reason. Never lower the threshold or take the best of a bad set; that is the difference
 * between missing honestly and missing silently.
 * @param {Selector} sel
 * @param {Control[]} candidates
 * @param {{ min?: number }} [opts]
 * @returns {{ control: Control|null, why?: "unbound"|"tied" }}
 */
export function resolve(sel, candidates, { min = WEIGHT.name } = {}) {
  /** @type {Control|null} */
  let best = null;
  let bestScore = -1, tied = false;
  for (const c of candidates) {
    const n = score(sel, c);
    if (n > bestScore) { best = c; bestScore = n; tied = false; }
    else if (n === bestScore && n >= min) tied = true;
  }
  if (bestScore < min) return { control: null, why: "unbound" };
  // Two controls that agree equally well is not a resolution. Say so rather than guess.
  if (tied) return { control: null, why: "tied" };
  return { control: best };
}
