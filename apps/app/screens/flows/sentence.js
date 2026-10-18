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

/** The same sentence as whenDo, in pieces: the words in between are plain and what starts it and each step are tokens (shown in the accent colour). Joined, the texts equal whenDo. @param {string} trigger @param {string[]} labels @returns {{ text: string, token: boolean }[]} */
export function sentenceParts(trigger, labels) {
  const when = trigger ? lc(trigger.replace(/^when\s+/i, "")) : "it starts";
  const shown = labels.slice(0, 3).map(lc);
  const more = labels.length - shown.length;
  /** @type {{ text: string, token: boolean }[]} */ const out = [{ text: "When ", token: false }, { text: when, token: true }, { text: ", ", token: false }];
  if (!shown.length) out.push({ text: "do nothing yet", token: false });
  shown.forEach((s, i) => { if (i) out.push({ text: ", then ", token: false }); out.push({ text: s, token: true }); });
  if (shown.length && more > 0) out.push({ text: `, then ${more} more step${more === 1 ? "" : "s"}`, token: false });
  out.push({ text: ".", token: false });
  return out;
}
