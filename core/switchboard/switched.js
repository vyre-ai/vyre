// @ts-check
// The words a thread says when its provider changes (moved out of index.js unchanged).

/** What a provider is called in a line a person reads. @param {string} p */
export const providerName = p => (p === "openrouter" ? "OpenRouter" : String(p || "claude")[0].toUpperCase() + String(p || "claude").slice(1));

/** The things a provider can do that a person would miss, in the words a notice uses. */
const CAP_WORDS = { rewind: "going back to an earlier turn", steering: "steering a turn that is running", questions: "asking you questions with options", interrupt: "stopping a turn midway", transcripts: "opening its transcript in a terminal" };

/**
 * The line a thread says when its provider changes: what the new one has, and what it does not. Plain words, never a promise Vyre cannot keep.
 * @param {{ from: string, to: string, had: boolean, reason?: string, fromCaps?: any, toCaps?: any }} o
 */
export function switchedLine({ from, to, had, reason = "asked", fromCaps = {}, toCaps = {} }) {
  const f = providerName(from), t = providerName(to);
  if (reason === "back") return `Back on ${t}. It has this session's memory and files, and what ${f} said this turn.`;
  const parts = [reason === "limit" ? `${f}'s limit was reached.` : "", reason === "once" ? `This turn runs on ${t}. It has this session's memory and files. The session stays on ${f}.` : `Switched to ${t}. It has this session's memory and files.`];
  // A provider that never ran the thread starts from what was said so far, not from the other one's own notes and tool results.
  if (!had && reason !== "once") parts.push(`It starts from what was said so far, not from ${f}'s own working notes.`);
  const lost = Object.keys(CAP_WORDS).filter(k => fromCaps[k] && !toCaps[k]).map(k => CAP_WORDS[k]);
  if (lost.length) parts.push(`${t} cannot do these here: ${lost.join(", ")}.`);
  return parts.filter(Boolean).join(" ");
}
