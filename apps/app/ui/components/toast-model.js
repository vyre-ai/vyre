// @ts-check
// The one rule for what a toast says, applied in showToast so no screen can skip it: a sentence that starts with a capital, and short. A server refusal often arrives lowercase and long
// ("no computer of yours is set up ...: turn on ..."); the toast keeps its first sentence, and the next step belongs on the toast's button, not in more words.

const LONG = 120;

/** @param {unknown} line @returns {string} */
export function toastLine(line) {
  let s = String(line ?? "").replace(/\s+/g, " ").trim();
  if (!s) return s;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length <= LONG) return s;
  // the first whole sentence, when it is a real one
  const first = /^(.{12,}?[.!?])\s/.exec(s);
  if (first && first[1].length <= LONG) return first[1];
  // else the part before a colon (the specifics after it are for the card that explains, not the toast)
  const colon = s.indexOf(": ");
  if (colon >= 12 && colon <= LONG) return `${s.slice(0, colon)}.`;
  return `${s.slice(0, LONG - 3).replace(/\s+\S*$/, "")}...`;
}
