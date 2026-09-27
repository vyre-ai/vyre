// @ts-check
// iq/heard: an agent corrects memory only with the person's own words behind it.
//
// The person tells an agent in chat "no, my wife is Juno". The agent calls memory.correct with
// from_turn: { seq }, a turn of its OWN thread (the thread vyred verified for the call, never one
// named in the input). The switchboard says who wrote that turn (threads.said): only a prompt the
// person typed counts, never tool output, a web page, a file, a launch brief or another agent's
// words. That turn must be fresh (the person's latest few, within minutes), must name what is
// being corrected, and must carry the correction itself: the new value's words, or a "no" next
// to the old value's words. Anything short of that is kept as a suggestion, never applied.
// (e2e's review of f49f7b02: words that merely appear somewhere in some past turn prove nothing.)

import { userWords } from "../personal/trust.js";
import { mustAppear } from "./ask.js";

/** Words that say something is wrong or should be forgotten. */
const DENY = /^(?:no|not|wrong|incorrect|isn't|isnt|wasn't|wasnt|aren't|arent|forget|never|nope|stop|ended|anymore|longer)$/;
/** A "no" counts only this many words from the old value's words. */
export const NEAR = 6;
/** Only the person's latest turns count, and only while fresh. */
export const FRESH = { back: 2, ms: 10 * 60_000 };
const STOP = new Set("the a an is was are were be of to in on at for and or but with from that this it its your my our their his her you i me we they what whats which who whom when where why how did does do has have had".split(" "));
const norm = s => String(s || "").toLowerCase().replace(/[‘’`]/g, "'");
const tokens = s => norm(s).split(/[^\p{L}\p{N}'./@-]+/u).map(w => w.replace(/^[.'-]+|[.'-]+$/g, "")).filter(Boolean);

/**
 * The words a value stands on: its names, numbers, paths and quoted words, else its content words.
 * "Your wife is Juno." needs "Juno"; "vegetarian" needs "vegetarian".
 * @param {string} value
 */
export function valueWords(value) {
  const hard = mustAppear(value);
  if (hard.length) return hard;
  return contentWords(value);
}

/** Content words: three letters or more, not a function word. @param {string} s */
export const contentWords = s => [...new Set(tokens(s).map(w => w.replace(/'s$/, "")).filter(w => w.length >= 3 && !STOP.has(w)))];

/**
 * Does the person's own turn carry this correction?
 * @param {{ by?: string, role?: string, text?: string, ts?: number, back?: number }|null} turn  threads.said's answer
 * @param {{ action: string, value?: string|null, old?: string|null, about: string[] }} c
 *   value: the new value (replace, add); old: what is being said to be wrong (wrong, forget, ended);
 *   about: words that name what is corrected (the fact's subject and relation, or the question's)
 * @param {number} now
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function heard(turn, c, now = Date.now()) {
  if (!turn) return { ok: false, why: "no such turn in this thread" };
  if (turn.role !== "user" || turn.by !== "person") return { ok: false, why: `that turn is not the person's own words (${turn.role || "?"} by ${turn.by || "?"})` };
  if (!Number.isInteger(turn.back) || /** @type {number} */ (turn.back) > FRESH.back || !(Number(turn.ts) >= now - FRESH.ms)) return { ok: false, why: "that turn is not one of the person's latest: only what they just said counts" };
  const said = norm(userWords(String(turn.text || "")));
  if (!said.trim()) return { ok: false, why: "that turn has no words of the person's" };
  const words = tokens(said);
  const has = w => said.includes(norm(w));
  // (a) The turn names what is corrected: at least one word of its subject, relation or question.
  const about = c.about.filter(Boolean);
  if (about.length && !about.some(has)) return { ok: false, why: "that turn does not name what is corrected" };
  if (c.value != null && String(c.value).trim()) {
    const need = valueWords(String(c.value));
    if (!need.length) return { ok: false, why: "the correction has no words to check" };
    const missing = need.filter(w => !has(w));
    if (missing.length) return { ok: false, why: `not in what the person said: ${missing.slice(0, 3).join(", ")}` };
    return { ok: true };
  }
  // wrong, forget, ended: a "no" next to the old value's words, not anywhere in the turn.
  const old = valueWords(String(c.old || "")).map(w => tokens(w)[0]).filter(Boolean);
  if (!old.length) return { ok: false, why: "nothing to say is wrong" };
  const at = words.flatMap((w, i) => (old.includes(w) ? [i] : []));
  if (!at.length) return { ok: false, why: "the person did not name what is wrong" };
  const deny = words.flatMap((w, i) => (DENY.test(w) ? [i] : []));
  if (!deny.some(d => at.some(i => Math.abs(i - d) <= NEAR))) return { ok: false, why: "the person did not say it was wrong" };
  return { ok: true };
}
