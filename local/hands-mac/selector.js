// @ts-check
// selector: how the hands say "this control" in a way that survives the window moving.
//
// A tree path (/0/1/3) and a screen point are both properties of one observation, not of the
// control. Opening a sidebar renumbers every path after it, and resizing the window moves
// every point. An agent that remembers either one remembers a mistake and clicks confidently
// on the wrong thing, which looks exactly like working until it does not.
//
// So a selector is a set of attributes ranked by how far they can be trusted, and it is
// resolved against a FRESH observation every time it is used. Nothing here stores a location
// as identity; the path rides along only to break a tie between identical siblings.

/**
 * @typedef {{ path: string, role: string, name?: string, namedBy?: string, identifier?: string,
 *   subrole?: string, container?: string, value?: string, secure?: boolean, enabled?: boolean,
 *   focused?: boolean, frame?: { x: number, y: number, w: number, h: number } }} Element
 * @typedef {{ role: string, identifier?: string, name?: string, container?: string, path?: string }} Selector
 */

/** Write down what makes this control itself. */
export function of(/** @type {Element} */ el) {
  /** @type {Selector} */
  const sel = { role: el.role };
  if (el.identifier) sel.identifier = el.identifier;
  if (el.name) sel.name = el.name;
  if (el.container) sel.container = el.container;
  if (el.path) sel.path = el.path;
  return sel;
}

// What each kind of agreement is worth. An identifier is the app's own stable handle, so it
// outranks a name; a name outranks a container; a path is worth almost nothing and exists only
// to break a tie between candidates that agree on everything else.
export const WEIGHT = { identifier: 100, name: 40, container: 10, path: 1 };

/** How well an element matches a selector, or -1 when it cannot be the one meant. */
export function score(/** @type {Selector} */ sel, /** @type {Element} */ el) {
  // Role is a gate, not a score. A text field is never the button you meant however much else
  // agrees, and letting a strong name override that is how a search for "Share" lands in a
  // "Share" text field and types into it.
  if (sel.role && el.role !== sel.role) return -1;
  let n = 0;
  if (sel.identifier && el.identifier === sel.identifier) n += WEIGHT.identifier;
  if (sel.name && el.name === sel.name) n += WEIGHT.name;
  if (sel.container && el.container === sel.container) n += WEIGHT.container;
  if (sel.path && el.path === sel.path) n += WEIGHT.path;
  return n;
}

/**
 * The bar a match must clear. A selector naming an identifier or a name must agree on at least
 * one of them. A selector with neither (a nameless control) can only be found by role, container
 * and path, which is weak, so it must agree on all three it gave.
 */
function minimum(/** @type {Selector} */ sel) {
  if (sel.identifier && sel.name) return WEIGHT.name;
  if (sel.identifier) return WEIGHT.identifier;
  if (sel.name) return WEIGHT.name;
  return (sel.container ? WEIGHT.container : 0) + (sel.path ? WEIGHT.path : 0) || Infinity;
}

/**
 * Find this control in a fresh observation.
 *
 * No match is a real answer and the caller must treat it as one. The recovery for a selector
 * that will not resolve is to observe again or to stop with a reason. It is never to lower the
 * bar or take the best of a bad set: that is the difference between a system that misses
 * honestly and one that misses silently. Two equally good candidates is not a match either.
 *
 * @param {Selector} sel
 * @param {Element[]} elements
 * @returns {{ element: Element } | { element: null, why: string }}
 */
export function resolve(sel, elements) {
  if (!sel || typeof sel.role !== "string") return { element: null, why: "a selector needs at least a role" };
  const min = minimum(sel);
  let best = null, bestScore = -1, tied = false;
  for (const el of elements) {
    const n = score(sel, el);
    if (n > bestScore) { best = el; bestScore = n; tied = false; }
    else if (n === bestScore && n >= min) tied = true;
  }
  if (!best || bestScore < min) return { element: null, why: `nothing on screen matches ${describe(sel)}` };
  if (tied) return { element: null, why: `more than one control matches ${describe(sel)} equally; give its identifier, container or path` };
  return { element: best };
}

/** A selector in words, for messages. */
export function describe(/** @type {Selector} */ sel) {
  const role = String(sel.role || "?").replace(/^AX/, "").toLowerCase();
  const bits = [sel.name ? `${role} "${sel.name}"` : `nameless ${role}`];
  if (sel.identifier) bits.push(`id ${sel.identifier}`);
  if (sel.container) bits.push(`in ${sel.container}`);
  return bits.join(" ");
}
