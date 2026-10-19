// The text of a field that holds values as pills (token-field-model.test.js): split into words and tokens, put back together, and name a token for its pill. Pure; no React.

/** @typedef {{ token: string, label: string, maybe?: string }} TokenOption */
/** @typedef {{ text: string } | { token: string }} Segment */

const TOKEN = /(?<!\{)\{([^{}]+)\}(?!\})/g;

/** The text as words and `{token}` pieces, in order. Doubled braces stay words. @param {string} text @returns {Segment[]} */
export function segmentsOf(text) {
  const s = String(text ?? "");
  /** @type {Segment[]} */ const out = [];
  let at = 0;
  for (const m of s.matchAll(TOKEN)) {
    const i = /** @type {number} */ (m.index);
    if (i > at) out.push({ text: s.slice(at, i) });
    out.push({ token: m[1] });
    at = i + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** The pieces back to the stored text. @param {Segment[]} segs */
export const textOf = (segs) => segs.map((x) => ("token" in x ? `{${x.token}}` : x.text)).join("");

/** The path of a token and its fallback, when it has one (`{steps.x.id | someone}`). @param {string} token @returns {{ path: string, fallback: string | null }} */
export function splitToken(token) {
  const i = token.indexOf("|");
  return i < 0 ? { path: token.trim(), fallback: null } : { path: token.slice(0, i).trim(), fallback: token.slice(i + 1).trim().replace(/^"(.*)"$/, "$1") };
}

const cap = (/** @type {string} */ p) => p.charAt(0).toUpperCase() + p.slice(1).replace(/_/g, " ");

/** What a pill says: the option's own words when the token is one the field can insert, else the path with each part in label case; a fallback is added as "or <fallback>". @param {string} token @param {TokenOption[]} options */
export function pillLabel(token, options) {
  const { path, fallback } = splitToken(token);
  const hit = options.find((o) => splitToken(o.token.replace(/^\{|\}$/g, "")).path === path);
  const base = hit ? hit.label : path.replace(/^(trigger|steps|event)\./, "").split(".").map(cap).join(" · ");
  return fallback ? `${base} (or ${fallback})` : base;
}

/** The text with one token added at a place in it (the end when none): `at` counts characters of the stored text. @param {string} text @param {string} token @param {number} [at] */
export function insertToken(text, token, at) {
  const s = String(text ?? "");
  const i = at === undefined || at < 0 || at > s.length ? s.length : at;
  return `${s.slice(0, i)}{${token}}${s.slice(i)}`;
}
