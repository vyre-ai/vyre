// Words for the Flows limits (limits-model.test.js).

/** "12,300 of 200,000 used today" and whether it is nearly used up. @param {{ tokens_per_day: number, used_today: number }} b */
export function budgetWords(b) {
  const n = (/** @type {number} */ x) => new Intl.NumberFormat("en-US").format(x);
  const left = b.tokens_per_day - b.used_today;
  return { line: `${n(b.used_today)} of ${n(b.tokens_per_day)} used today`, low: b.tokens_per_day > 0 && left <= b.tokens_per_day * 0.1 };
}

/** The Space's switch in plain words. @param {{ mode: string, reason?: string, held: number, dropped: number }} c */
export function controlWords(c) {
  const mode = c.mode === "running" ? "Flows are running" : c.mode === "paused" ? "Flows are paused" : "Flows are finishing what they started";
  const extra = [c.reason, c.held ? `${c.held} held` : "", c.dropped ? `${c.dropped} events dropped` : ""].filter(Boolean).join(", ");
  return extra ? `${mode} (${extra})` : mode;
}

/** A whole number of tokens from what was typed; null when it is not one above zero. @param {string} text */
export const tokensFrom = (text) => { const n = Number(String(text).replace(/[,\s]/g, "")); return Number.isInteger(n) && n > 0 ? n : null; };
