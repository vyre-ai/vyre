// @ts-check
// The calm card Now shows while a space's records are still being set up for the first time (about a minute): what to say, from spaces.records.status. Never an error and never an empty list. Pure.

/**
 * @param {unknown} d the answer of spaces.records.status
 * @returns {{ title: string, line: string, detail: string | null } | null} null when every space's records are ready (or the box cannot say)
 */
export function recordsSetup(d) {
  const list = d && typeof d === "object" && Array.isArray(/** @type {any} */ (d).spaces) ? /** @type {any} */ (d).spaces : [];
  const waiting = list.filter((/** @type {any} */ s) => s && s.ready === false);
  if (!waiting.length) return null;
  const words = String(waiting[0].words || "").replace(/^the record store (for this space )?is (still starting|not available yet)(: )?/i, "").trim();
  return { title: "Setting up your records", line: "This takes about a minute the first time. You can keep going; what needs your records appears as soon as they are ready.", detail: words ? words.charAt(0).toUpperCase() + words.slice(1) : null };
}
