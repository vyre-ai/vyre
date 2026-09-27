// @ts-check
// iq/heard: an agent corrects memory only with the person's own words behind it.
//
// The person tells an agent in chat "no, my wife is Juno". The agent calls memory.correct with
// from_turn: { seq }, a turn of its OWN thread (the thread vyred verified for the call, never one
// named in the input). The switchboard says who wrote that turn (threads.said): only a prompt the
// person typed counts, never tool output, a web page, a file, a launch brief or another agent's
// words. The value the correction sets must be in that turn's own words, as the person wrote it.
// Anything short of that is kept as a suggestion for the person to accept, never applied.

import { userWords } from "../personal/trust.js";
import { mustAppear } from "./ask.js";

/** Words that say something is wrong or should be forgotten: a correction with no new value needs one. */
const DENY = /\b(?:no|not|wrong|incorrect|isn'?t|wasn'?t|aren'?t|forget|never|nope|stop)\b/i;
const STOP = new Set("the a an is was are were be of to in on at for and or but with from that this it its your my our their his her you i me we they".split(" "));
const norm = s => String(s || "").toLowerCase().replace(/[‘’`]/g, "'");

/**
 * The words a correction's value stands on: its names, numbers, paths and quoted words, else its
 * content words. "Your wife is Juno." needs "Juno"; "vegetarian" needs "vegetarian".
 * @param {string} value
 */
export function valueWords(value) {
  const hard = mustAppear(value);
  if (hard.length) return hard;
  return String(value || "").toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter(w => w.length >= 3 && !STOP.has(w));
}

/**
 * Does the person's own turn carry this correction?
 * @param {{ by?: string, role?: string, text?: string }|null} turn  threads.said's answer
 * @param {{ action: string, value?: string|null }} c
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function heard(turn, c) {
  if (!turn) return { ok: false, why: "no such turn in this thread" };
  if (turn.role !== "user" || turn.by !== "person") return { ok: false, why: `that turn is not the person's own words (${turn.role || "?"} by ${turn.by || "?"})` };
  const said = norm(userWords(String(turn.text || "")));
  if (!said.trim()) return { ok: false, why: "that turn has no words of the person's" };
  if (c.value != null && String(c.value).trim()) {
    const need = valueWords(String(c.value));
    if (!need.length) return { ok: false, why: "the correction has no words to check" };
    const missing = need.filter(w => !said.includes(norm(w)));
    if (missing.length) return { ok: false, why: `not in what the person said: ${missing.slice(0, 3).join(", ")}` };
    return { ok: true };
  }
  return DENY.test(said) ? { ok: true } : { ok: false, why: "the person did not say it was wrong" };
}
