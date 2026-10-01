// @ts-check
// spoken: the assistant's written reply as something worth saying aloud.
//
// A reply is written for a screen: markdown, code, tables, links, long lists. Said aloud those
// are noise or worse (a speech engine reads a URL out character by character, and a table as
// pipes). spoken() keeps the prose, drops what cannot be said, and cuts at a sentence end inside
// the limit, so a long reply becomes its first few sentences and nothing is ever cut mid-word.
// What was left out is told once, in words, so the person knows the rest is on screen.
//
// Every line-anchored pattern uses [ \t], never \s: \s also matches a newline, so a reply of nothing
// but blanks or newlines made them cubic (20000 spaces froze vyred for seconds, then hours at scale).
// Pure: no I/O, no provider. voice.speak calls it when asked for a `reply`.

export const MAX_SPOKEN = 600;
/** Only the start of a reply is ever said, so only the start is read. */
export const MAX_INPUT = 20_000;
const TAIL = "The rest is on your screen.";

/**
 * @param {string} text the reply as written
 * @param {number} [max] characters
 * @returns {{ text: string, cut: boolean }} text is empty when nothing in the reply can be said
 */
export function spoken(text, max = MAX_SPOKEN) {
  let s = String(text ?? "").slice(0, MAX_INPUT).replace(/\r\n?/g, "\n");
  let dropped = false;
  const drop = (re, to = " ") => { s = s.replace(re, m => { dropped = true; return to; }); };
  drop(/```[\s\S]*?(```|$)/g);                       // fenced code
  drop(/~~~[\s\S]*?(~~~|$)/g);
  drop(/^[ \t]*\|.*\|[ \t]*$/gm, "\n");                    // table rows
  drop(/^[ \t]*[-:|][-:| \t]{2,}$/gm, "\n");                // table rules
  drop(/<[^>\n]{1,200}>/g);                          // markup
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")     // image: its alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")         // link: its words
    .replace(/https?:\/\/\S+/g, () => { dropped = true; return "a link"; })
    .replace(/`([^`]+)`/g, "$1")                     // inline code: the words
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, "")              // headings
    .replace(/^[ \t]*>[ \t]?/gm, "")                       // quote marks
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~\n]*?)(?<=\S)\1/g, "$2") // emphasis
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")       // list markers
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  // Sentences: a line end, or terminal punctuation followed by a space, ends one.
  const parts = s.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  let out = "";
  let cut = false;
  for (const p of parts) {
    const add = out ? `${out} ${p}` : p;
    if (add.length > max - (TAIL.length + 1)) { cut = true; break; }
    out = add;
  }
  if (!out && parts.length) {
    // One long sentence: cut at a word.
    out = parts[0].slice(0, max - (TAIL.length + 2)).replace(/\s+\S*$/, "").trim();
    cut = Boolean(out);
  }
  if (!out) return { text: "", cut: false };
  return { text: cut || dropped ? `${out}${/[.!?]$/.test(out) ? "" : "."} ${TAIL}` : out, cut: cut || dropped };
}
