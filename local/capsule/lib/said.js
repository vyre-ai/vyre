// @ts-check
// said — which of the user's past turns answer what they just asked, and the answer in one line.
//
// recall.search ranks by words, so for "which car do I own" it finds the question itself first:
// the same words asked a minute ago, the Capsule's own quick thread named after them, and a dev
// session talking about the question. None of those answers it. What does is a statement the user
// made about themselves ("I own a blue Volvo XC40"). So, before anything is shown:
//   - out: the Capsule's own ask threads (named "Capsule: ..." or run in its scratch folder), any
//     turn that repeats the question (nearly all its words, or the whole phrase quoted)
//   - down: questions, and Claude's words
//   - up: the user's first-person statements that share a word with the question
//   - at most MAX_SAID
// When the best is a clear first-person statement, it becomes one line on top, turned to the user
// ("You own a blue Volvo XC40."), with the quote under it as its source.

import { words } from "./route.js";

export const MAX_SAID = 2;

/** Folded for comparing: lower case, words only. */
const fold = s => String(s || "").toLowerCase().replace(/[«»]/g, "").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

const QUESTION = /^(who|what|which|where|when|why|how|do|does|did|is|are|was|were|can|could|should|would|will|have|has)\b/;
/** A turn that asks rather than tells. */
export const isQuestion = t => /\?\s*$/.test(String(t).trim()) || QUESTION.test(fold(t));

/** The user speaking about themselves: "I own", "I'm", "my car is". */
const FIRST = /(^|[^a-z'])(i|i'm|i've|i'd|my|mine|we|our)([^a-z']|$)/i;

/**
 * Hits worth showing for `query`, best first, at most MAX_SAID.
 * @param {any[]} hits recall.search rows ({ role, text|snippet, name, title, cwd }), in its order
 * @param {string} query
 * @param {{ scratch?: string|null }} [opts] the Capsule's ask folder, whose threads are its own
 */
export function rankSaid(hits, query, { scratch = null } = {}) {
  const q = fold(query);
  const qw = words(query);
  const own = h => /^Capsule: /.test(String(h.name || h.title || "")) || (scratch && h.cwd && String(h.cwd).startsWith(scratch));
  const repeats = h => {
    const t = fold(h.text || h.snippet);
    if (q.split(" ").length >= 3 && t.includes(q)) return true;          // the whole question, asked or talked about
    const tw = words(h.text || h.snippet);
    if (!qw.length || !tw.length) return false;
    const shared = qw.filter(w => tw.includes(w)).length;
    return shared / qw.length >= 0.8 && tw.length <= qw.length + 2;     // nearly the same words, and little else
  };
  return hits
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => !own(h) && !repeats(h))
    .map(({ h, i }) => {
      const t = String(h.text || h.snippet || "");
      const user = h.role !== "assistant";
      let s = -i;                                                         // recall's own order breaks ties
      if (isQuestion(t)) s -= 20;
      if (!user) s -= 5;
      if (user && FIRST.test(t) && !isQuestion(t) && sharesWord(t, qw)) s += 20;
      return { h, s };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_SAID)
    .map(x => x.h);
}

const sharesWord = (t, qw) => { const tw = words(t); return qw.some(w => tw.includes(w)); };

/** First person to second, for a line about the user. */
const SWAP = [[/\bI am\b/g, "you are"], [/\bI'm\b/g, "you're"], [/\bI've\b/g, "you've"], [/\bI'd\b/g, "you'd"], [/\bI was\b/g, "you were"],
  [/\bI\b/g, "you"], [/\bmyself\b/gi, "yourself"], [/\bmy\b/gi, "your"], [/\bmine\b/gi, "yours"], [/\bme\b/g, "you"]];

/**
 * The one-line answer from a hit, or null: only the user's own clear statement about themselves
 * that shares a word with the question ("I own a blue Volvo XC40" -> "You own a blue Volvo
 * XC40."). The sentence is the first one that starts with I or My and names a word asked about.
 * @param {any} hit @param {string} query
 */
export function yourAnswer(hit, query) {
  if (!hit || hit.role === "assistant") return null;
  const qw = words(query);
  const text = String(hit.text || hit.snippet || "").replace(/[«»]/g, "");
  const sentence = text.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim())
    .find(x => /^(i|i'm|i've|my)\b/i.test(x) && !isQuestion(x) && sharesWord(x, qw));
  if (!sentence) return null;
  let out = sentence.replace(/[.!\s]+$/, "");
  for (const [re, to] of SWAP) out = out.replace(re, /** @type {string} */ (to));
  out = out.charAt(0).toUpperCase() + out.slice(1);
  return (out.length > 120 ? out.slice(0, 119).replace(/\s+\S*$/, "") + "…" : out) + (out.length > 120 ? "" : ".");
}
