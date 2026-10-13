// @ts-check
// The "When X, do Y" line for a Flow that is stored as labelled steps (the sample Kit Flows and real Flows from flows.graph), in the same voice the builder uses.

const lc = (/** @type {string} */ s) => (s && s.length > 1 && !/[A-Z]/.test(s[1]) ? s[0].toLowerCase() + s.slice(1) : s);

/** @param {string} trigger "A payment is received" @param {string[]} labels the step labels in order @returns {string} */
export function whenDo(trigger, labels) {
  const when = trigger ? lc(trigger.replace(/^when\s+/i, "")) : "it starts";
  const shown = labels.slice(0, 3).map(lc);
  const more = labels.length - shown.length;
  const body = shown.length ? shown.join(", then ") + (more > 0 ? `, then ${more} more step${more === 1 ? "" : "s"}` : "") : "do nothing yet";
  return `When ${when}, ${body}.`;
}
