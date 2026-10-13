// A typed code such as WINK-4F7K-9QZ2: uppercase letters and digits in groups joined by a hyphen, with an optional fixed first word.
// Typing is forgiving the way the pairing code is (otp.md): case, spaces and hyphens are ignored, a pasted prefix is not doubled.

const clean = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The text to show for what was typed. `groups` is the length of each group after the prefix; `prefix` is a fixed first word ("WINK") shown from the first key.
 * @param {string} raw @param {{ prefix?: string, groups?: number[] }} [shape]
 */
export function formatCode(raw, { prefix = "", groups = [4, 4] } = {}) {
  let body = clean(raw);
  const p = clean(prefix);
  if (p && body.startsWith(p)) body = body.slice(p.length);
  else if (p && p.startsWith(body)) body = "";
  const out = [];
  let at = 0;
  for (const n of groups) {
    if (at >= body.length) break;
    out.push(body.slice(at, at + n));
    at += n;
  }
  return [...(p && (body.length || clean(raw).length) ? [p] : []), ...out].join("-");
}

/** True when every group is full. */
export function codeComplete(raw, shape = {}) {
  const { prefix = "", groups = [4, 4] } = shape;
  let body = clean(raw);
  const p = clean(prefix);
  if (p && body.startsWith(p)) body = body.slice(p.length);
  return body.length === groups.reduce((a, b) => a + b, 0);
}
