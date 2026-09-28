// @ts-check
// A copy of the Gate's scrub (core/gate/senders.js), the same way core/connectors/auth.js keeps
// its own: modules never import each other's files (test/boundaries.test.js), so a small pure
// helper with no feature state is copied rather than given a new cross-module edge.

const CONCEALED = "<concealed by vyre>";
const isStr = v => typeof v === "string";

/**
 * Replace every occurrence of each value, and of its base64, base64url and URL-encoded forms,
 * with a marker. Values under 4 characters are skipped: scrubbing them would shred text.
 * @param {unknown} text @param {string[]} values
 */
export function scrub(text, values) {
  let out = String(text ?? "");
  const forms = new Set();
  for (const v of values || []) {
    if (!isStr(v) || v.length < 4) continue;
    const b = Buffer.from(v, "utf8");
    for (const f of [v, b.toString("base64"), b.toString("base64").replace(/=+$/, ""), b.toString("base64url"),
      encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+"), JSON.stringify(v).slice(1, -1)]) if (f.length >= 4) forms.add(f);
  }
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join(CONCEALED);
  return out;
}
