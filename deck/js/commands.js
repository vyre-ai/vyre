// @ts-check
// What Find's box does on Enter, read from the words: the same grammar as the Mac Lumen and the
// native apps (team mobile, team/archive/CONTRACT-native-apps.md), tried in this order, ignoring case:
//
//   @<agent> <text>                                    ask that agent
//   (tell|ping|notify) me when [the] <session> [thread] [is] (done|finishes|finished|asks)
//                                                      watch it
//   (tell|ask) [the] <session> [thread] to <text>      type into it, then watch it
//   (watch|monitor|track) [the] <session> [thread] [and tell me ...]
//                                                      watch it
//   anything else                                      ask the assistant
//
// A session is matched by name among the rows Find already has: an exact name, then the name
// with punctuation dropped, then every word of it, then its letters in order. No match, and the
// words go to the assistant after all. Pure: no DOM, no calls, so node tests import it.

/**
 * @typedef {{ id: string, name?: string|null, title?: string|null, project?: string|null }} SessionRow
 * @typedef {{ kind: "agent", agent: string, text: string }
 *   | { kind: "watch", query: string, until: "finished" | "asks" | "either", candidates: SessionRow[] }
 *   | { kind: "drive", query: string, text: string, candidates: SessionRow[] }
 *   | { kind: "ask", text: string }} Command
 */

const squash = (/** @type {string} */ s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const wordsOf = (/** @type {string} */ s) => String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [];

/**
 * Sessions whose name fits the words, best first.
 * @param {string} query @param {SessionRow[]} rows @param {(r: SessionRow) => string} [titleOf]
 * @returns {SessionRow[]}
 */
export function rankSessions(query, rows, titleOf = r => String(r.name || r.title || "")) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const qs = squash(q), qw = wordsOf(q);
  /** @type {[number, number, SessionRow][]} */ const scored = [];
  rows.forEach((r, i) => {
    const name = titleOf(r).trim().toLowerCase();
    if (!name) return;
    let score = 0;
    if (name === q) score = 4;
    else if (qs && squash(name) === qs) score = 3;
    else if (qw.length && qw.every(w => wordsOf(name).includes(w))) score = 2;
    else if (qs && subsequence(qs, squash(name))) score = 1;
    if (score) scored.push([score, i, r]);
  });
  return scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(x => x[2]);
}

/** Are the letters of `a` in `b`, in order? */
function subsequence(/** @type {string} */ a, /** @type {string} */ b) {
  let i = 0;
  for (const c of b) if (c === a[i]) i++;
  return i === a.length;
}

/**
 * @param {string} input what is in the box
 * @param {{ agents: { name: string }[], sessions: SessionRow[], titleOf?: (r: SessionRow) => string }} world
 * @returns {Command}
 */
export function parseCommand(input, { agents, sessions, titleOf }) {
  const text = String(input || "").trim();
  let m = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  if (m) {
    const agent = agents.find(a => a.name.toLowerCase() === m?.[1].toLowerCase());
    if (agent) return { kind: "agent", agent: agent.name, text: m[2].trim() };
  }
  const bySession = (/** @type {string} */ q) => rankSessions(q, sessions, titleOf);
  if ((m = /^(?:tell|ping|notify) me when (?:the )?(.+?)(?: thread)?(?: is)? (done|finishes|finished|asks)$/i.exec(text))) {
    const candidates = bySession(m[1]);
    if (candidates.length) return { kind: "watch", query: m[1], until: /asks/i.test(m[2]) ? "asks" : "finished", candidates };
  }
  if ((m = /^(?:tell|ask) (?:the )?(.+?)(?: thread)? to ([\s\S]+)$/i.exec(text))) {
    const candidates = bySession(m[1]);
    if (candidates.length) return { kind: "drive", query: m[1], text: m[2].trim(), candidates };
  }
  if ((m = /^(?:watch|monitor|track) (?:the )?(.+?)(?: thread)?(?: and tell me.*)?$/i.exec(text))) {
    const candidates = bySession(m[1]);
    if (candidates.length) return { kind: "watch", query: m[1], until: "either", candidates };
  }
  return { kind: "ask", text };
}

/**
 * The line under the box: what Enter will do.
 * @param {Command} c @param {string} name the chosen session's name, for drive and watch
 * @param {string} assistant
 */
export function plan(c, name, assistant) {
  if (c.kind === "agent") return `Enter asks ${c.agent}.`;
  if (c.kind === "drive") return `Enter types into ${name}, then watches it.`;
  if (c.kind === "watch") return c.until === "asks" ? `Enter watches ${name} and tells you when it asks.`
    : c.until === "finished" ? `Enter watches ${name} and tells you when it is done.` : `Enter watches ${name}. You hear when it finishes or asks.`;
  return `Enter asks ${assistant}.`;
}
