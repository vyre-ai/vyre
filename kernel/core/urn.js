// kernel/core/urn.js: `vyre://<space>/<type>/<id>[/<path>]` and the selector match (contract 3.3, 6.2).
// A selector is a prefix with `*` standing for exactly one segment; it covers the resource at that depth and below.

/** @param {string} urn @returns {string[] | null} the segments after `vyre://`, or null when it is not a URN */
export function segments(urn) {
  if (typeof urn !== "string" || !urn.startsWith("vyre://")) return null;
  const s = urn.slice(7).split("/");
  return s.length >= 1 && s.every(x => x.length > 0) ? s : null;
}

export const spaceOf = (/** @type {string} */ urn) => { const s = segments(urn); return s ? s[0] : null; };

/** Does `prefix` cover `urn`? A `*` segment matches one segment of any value. */
export function covers(prefix, urn) {
  const p = segments(prefix), u = segments(urn);
  if (!p || !u || p.length > u.length) return false;
  return p.every((seg, i) => seg === "*" || seg === u[i]);
}

/** Is selector prefix `deep` provably inside `wide`? Same or deeper, segment by segment, a `*` in `deep` only under a `*`. */
export function containedPrefix(deep, wide) {
  const d = segments(deep), w = segments(wide);
  if (!d || !w || d.length < w.length) return false;
  return w.every((seg, i) => seg === "*" || (d[i] !== "*" && seg === d[i]));
}
