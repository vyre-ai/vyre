// @ts-check
// plain prose: the pattern list and the em-dash normaliser for the house writing voice
// (docs/adr/0037-style.md). A lib, not a module (ADR 0033): no feature state, so the Deck, the
// Capsule's web views and core can all import it directly, with no ctx.call and no module
// dependency. core/style's style.patterns tool serves PATTERNS over the wire for a surface that
// can't import a file (a plugin, a remote MCP caller); anything running in this codebase imports
// this file instead.
//
// normalizeProse never touches a fenced code block, inline code, or (given the caller's own
// split) tool output: it is a display and drafting rule, never a rewrite of what a session
// actually said. The transcript keeps the model's raw text; only what a surface renders, or what
// Vyre drafts on the person's behalf before storing it, runs through this.

const EM_DASH = "—";

/**
 * One entry per banned pattern the house voice asks a model not to write, for a lint (never an
 * auto-fix) to flag a finished message against. `pattern`/`flags` are a RegExp's own source and
 * flags, so they travel over JSON (core/style's style.patterns tool) as well as importing here
 * directly. Only the lexically-detectable bans are here; structural ones (a reflex triad,
 * restating the question, a hedging stack) need a reader, not a regex, and are the house voice's
 * to ask for, not a lint's to catch.
 */
export const PATTERNS = Object.freeze([
  { id: "em-dash", label: "em dash", pattern: "\\u2014", flags: "g" },
  { id: "throat-clearing", label: "throat-clearing opener", pattern: "^(here's the thing|great question|it turns out|let me be clear|the truth is)\\b", flags: "i" },
  { id: "emphasis-crutch", label: "emphasis crutch", pattern: "\\b(let that sink in|full stop\\.|make no mistake)\\b", flags: "i" },
  { id: "not-x-its-y", label: "\"it's not X, it's Y\" framing", pattern: "\\bit'?s not\\b[^.!?]{0,80}\\bit'?s\\b", flags: "i" },
  { id: "jargon", label: "business jargon", pattern: "\\b(delve into|leverage|utilize|synerg\\w*|circle back|deep dive)\\b", flags: "i" },
  { id: "sycophancy", label: "sycophancy", pattern: "^(you'?re absolutely right|great point|i love that)\\b", flags: "i" },
  { id: "closing-offer", label: "unrequested closing offer", pattern: "\\blet me know if you'?d like\\b", flags: "i" },
]);

/**
 * Splits text into runs the normaliser may touch ("prose") and runs it never touches ("code"):
 * a fenced block (```...```, ~~~...~~~) or inline code (`...`). A lopsided fence or backtick
 * (no closing mark) is left as prose from that point on rather than swallowing the rest of the
 * text as "code": real prose after an accidental stray backtick still gets normalized.
 * @param {string} text @returns {{ kind: "prose"|"code", text: string }[]}
 */
export function splitProse(text) {
  /** @type {{ kind: "prose"|"code", text: string }[]} */
  const out = [];
  const re = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ kind: "prose", text: text.slice(last, m.index) });
    out.push({ kind: "code", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "prose", text: text.slice(last) });
  return out;
}

/**
 * One prose run's em dashes, replaced with the punctuation the sentence needs, never a blind
 * character swap: a paired dash ("A — B — C", the aside form) becomes parentheses ("A (B) C");
 * a single remaining dash becomes a comma, which reads correctly in every remaining case (a
 * pause, an explanation, an aside) even where a colon would read marginally better, and never
 * produces a sentence fragment the way a period could if the two sides aren't full clauses.
 * @param {string} prose
 */
function normalizeRun(prose) {
  let out = prose.replace(/ ?— ?([^—]*?) ?— ?/g, (_, aside) => ` (${aside.trim()}) `);
  out = out.replace(/\s*—\s*/g, ", ");
  // A comma landing right before closing punctuation, or doubled up from an adjacent one the
  // text already had, reads worse than none: ", ." -> "." ", , " -> ", ".
  out = out.replace(/, +([.!?,;:])/g, "$1").replace(/, *, +/g, ", ");
  return out;
}

/**
 * The whole guarantee: every em dash in `text` gone, none of it touching a fenced or inline code
 * span. Idempotent (running it twice changes nothing further) and safe on text with no em dash
 * at all (returns it unchanged, same reference cost as any string a caller already had).
 * @param {string} text
 */
export function normalizeProse(text) {
  if (!text || !text.includes(EM_DASH)) return text;
  return splitProse(text).map(p => (p.kind === "prose" ? normalizeRun(p.text) : p.text)).join("");
}
