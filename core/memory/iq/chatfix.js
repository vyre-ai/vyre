// @ts-check
// iq/chatfix: a correction the person makes in ordinary chat, caught by rules and applied as theirs.
//
// The person types "no, that's wrong" or "actually it's Vercel" right after a reply that came
// from memory. catchCorrection() reads their own typed words only; groundedAnswer() finds which
// memory.ask answer the reply repeated (so a reply that never came from memory is never taken as
// one); sourceOf() names where a correction came from, for the one corrections listing:
//   capsule       the person's own surfaces (Capsule, Deck, CLI)
//   chat:<thread> an agent passed on what the person said (memory.heard)
//   reader        the reader caught it in a session, with no agent involved

import { userWords } from "../personal/trust.js";
import { questionKey } from "./fix.js";
export { sourceOf } from "./fix.js";

const norm = s => String(s || "").replace(/[‘’`]/g, "'").replace(/\s+/g, " ").trim();
const DENY = /^(?:no|nope|wrong|incorrect|that'?s (?:not right|wrong|incorrect|not true|not correct)|that is (?:not right|wrong|incorrect|not true)|not right|not correct|that isn'?t (?:right|true|correct))\b/i;
const SAYS = [
  /^(?:no,?\s+)?(?:actually|in fact),?\s+(?:it'?s|it is|its|they'?re|that'?s|we use|we'?re using|we are using|we run|we host on|it was)\s+(.{2,80}?)[.!]?$/i,
  /^(?:no,?\s+)?(?:actually|in fact),?\s+(.{2,80}?)[.!]?$/i,
  /^(?:no,?\s+)?we (?:switched|moved|changed|went) (?:over )?to\s+(.{2,80}?)(?:\s+(?:last|in|on|a|two|three|\d)\b.*)?[.!]?$/i,
  /^(?:no,?\s+)?it'?s (?:now |actually )?(.{2,60}?) now[.!]?$/i,
];

/**
 * What a typed turn says about the reply before it, or null. deny: it says the reply was wrong.
 * replace: it says what is right instead (value is in the person's own words, from this turn).
 * A question is never a correction.
 * @param {string} text
 * @returns {{ action: "wrong" | "replace", value: string | null } | null}
 */
export function catchCorrection(text) {
  const t = norm(userWords(String(text || "")));
  if (!t || t.length > 300 || /\?\s*$/.test(t)) return null;
  // Whole sentence or leading clause only: "no, that's wrong" or "actually it's Vercel".
  const lead = t.split(/(?<=[.!])\s+/)[0];
  for (const re of SAYS) {
    const m = re.exec(lead);
    if (m && m[1] && !/^(?:that|this|it|so|the same)$/i.test(m[1].trim())) return { action: "replace", value: m[1].replace(/[.!,]+$/, "").trim() };
  }
  const cut = /^(?:no|nope)[,.!]?\s+(?:it'?s|it is|its)\s+(.{2,60}?)[.!]?$/i.exec(lead);
  if (cut && !/^(?:that|this|not)\b/i.test(cut[1])) return { action: "replace", value: cut[1].trim() };
  const next = /^(?:it'?s|it is|its)\s+(.{2,60}?)[.!]?$/i.exec(t.split(/(?<=[.!])\s+/)[1] || "");
  if (DENY.test(lead) && next && !/^(?:that|this|not)\b/i.test(next[1])) return { action: "replace", value: next[1].trim() };
  if (DENY.test(lead) && !/^no\b[,.!]?\s+(?:problem|worries|thanks|thank you|rush)/i.test(lead)) return { action: "wrong", value: null };
  return null;
}

/**
 * The memory.ask answer a reply repeated: the newest stored answer (within maxAgeMs) whose text
 * the reply contains, else null. A reply with no answer of memory's in it is not grounded.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} replyText @param {number} now @param {number} [maxAgeMs]
 * @returns {{ id: string, question: string, answer: string } | null}
 */
export function groundedAnswer(db, replyText, now, maxAgeMs = 3_600_000) {
  const reply = questionKey(replyText);
  if (!reply) return null;
  const rows = /** @type {any[]} */ (db.prepare("SELECT id, question, answer, at FROM memory_iq_answers WHERE at >= ? ORDER BY at DESC LIMIT 200").all(now - maxAgeMs));
  for (const r of rows) {
    const a = questionKey(String(r.answer));
    // Short answers ("Yes.") would match anything.
    if (a.length >= 8 && reply.includes(a)) return { id: String(r.id), question: String(r.question), answer: String(r.answer) };
  }
  return null;
}
