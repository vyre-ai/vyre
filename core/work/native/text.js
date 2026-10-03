// @ts-check
// Free text from records, tidied before it reaches a model: one line, no control characters, no angle brackets, capped.

/** One line of free text: control characters gone, angle brackets gone (a record cannot close the data block), capped. @param {any} s @param {number} [n] */
export function clean(s, n = 120) {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}
