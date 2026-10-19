// What a step test said, in plain lines (step-test-model.test.js). Pure.

/** Key and value pairs of a recorded input or output, dotted for nesting, label case. @param {any} v @param {string} [prefix] @returns {[string, string][]} */
export function pairsOf(v, prefix = "") {
  if (v === null || v === undefined) return [];
  if (typeof v !== "object") return [[label(prefix || "Value"), String(v)]];
  if (v.sealed === true) return [[label(prefix || "Value"), "Sealed"]];
  if (v.cut === true) return [[label(prefix || "Value"), "Too long to show, cut"]];
  return Object.entries(v).flatMap(([k, x]) => (x !== null && typeof x === "object" && !Array.isArray(x) ? pairsOf(x, prefix ? `${prefix}.${k}` : k) : [[label(prefix ? `${prefix}.${k}` : k), Array.isArray(x) ? x.map((y) => (typeof y === "object" ? JSON.stringify(y) : String(y))).join(", ") : String(x ?? "")]]));
}
const label = (/** @type {string} */ k) => k.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1).replace(/_/g, " ")).join(" · ");

/** @param {{ ok: boolean, input?: any, output?: any, effects?: { outward?: boolean, would?: string, action?: string }[], error?: any }} r */
export function testLines(r) {
  const err = r.error ? (typeof r.error === "string" ? r.error : r.error.message || r.error.code || "It failed.") : "";
  return {
    ok: r.ok && !err,
    error: r.ok ? "" : err || "It failed.",
    input: pairsOf(r.input),
    output: pairsOf(r.output),
    effects: (r.effects || []).map((e) => e.would || `Would do ${e.action || "something"}`),
    note: (r.effects || []).some((e) => e.outward) ? "Nothing was sent. Outward steps are only described." : "Nothing was changed.",
  };
}
