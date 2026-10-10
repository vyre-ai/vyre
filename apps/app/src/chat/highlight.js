// @ts-check
// Highlight to assistant (DESIGN-chat.md, "What your assistant can reach, and what is in front of it"): the person picks a message, a part of one or a terminal's output, and it
// sits as a small chip above the composer with one tap to remove it. It is quoted into the person's next message when THEY send; nothing is sent by highlighting. The pure side:
// what a selection is, the list of chips, and the quote the message carries.

export const MAX_HIGHLIGHTS = 5;
export const MAX_QUOTE = 600;

/** @typedef {{ id: string, from: string, quote: string, kind: "message" | "selection" | "terminal" }} Highlight */

const tidy = (/** @type {string} */ s) => String(s ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();

/** The text the window has selected right now (web), else "". Called when the person presses, before the press can clear it. */
export function readSelection() {
  try { const w = /** @type {any} */ (globalThis).window; return w && typeof w.getSelection === "function" ? String(w.getSelection() || "") : ""; } catch { return ""; }
}

/**
 * What of `text` the person selected: the selection when it is part of the text (a selection from somewhere else on the page is not this message's), else null so the whole item is taken.
 * @param {string} text @param {string} selected @returns {string | null}
 */
export function selectionIn(text, selected) {
  const s = tidy(selected);
  if (!s) return null;
  const norm = (/** @type {string} */ x) => x.replace(/\s+/g, " ");
  return norm(text).includes(norm(s)) ? s : null;
}

/** Cut to the quote's length, at a line or word where it can, with an ellipsis. @param {string} s */
function clip(s) {
  if (s.length <= MAX_QUOTE) return s;
  const cut = s.slice(0, MAX_QUOTE);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return `${(at > MAX_QUOTE * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * One highlight from what the person pressed on. A selection inside the item makes a "selection"; otherwise the whole item (a message, a terminal's output).
 * @param {{ from: string, text: string, selected?: string, kind?: "message" | "terminal", id?: string }} o @returns {Highlight | null}
 */
export function makeHighlight(o) {
  const text = tidy(o.text);
  const sel = o.selected ? selectionIn(text, o.selected) : null;
  const quote = clip(sel ?? text);
  if (!quote) return null;
  return { id: o.id ?? `h${Math.abs(hash(`${o.from}|${quote}`)).toString(36)}`, from: String(o.from || "").trim(), quote, kind: sel ? "selection" : o.kind ?? "message" };
}

/** @param {string} s */
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }

/** Add one, once: the same words from the same author are already there. At most five; a sixth takes the place of the oldest. @param {readonly Highlight[]} list @param {Highlight | null} h @returns {Highlight[]} */
export function addHighlight(list, h) {
  if (!h) return [...list];
  if (list.some((x) => x.id === h.id)) return [...list];
  return [...list, h].slice(-MAX_HIGHLIGHTS);
}

/** @param {readonly Highlight[]} list @param {string} id @returns {Highlight[]} */
export const removeHighlight = (list, id) => list.filter((x) => x.id !== id);

/** The chip's words: who it is from and the start of it, on one line. @param {Highlight} h */
export function chipLabel(h) {
  const one = h.quote.replace(/\s+/g, " ");
  const head = one.length > 48 ? `${one.slice(0, 47).trimEnd()}…` : one;
  return h.from ? `${h.from}: ${head}` : head;
}

/**
 * The message the person sends: each highlight quoted above what they typed ("> " lines, then who it is from), so the assistant reads it as a reference and the people in a group read
 * the same words. With nothing highlighted the text is unchanged.
 * @param {string} text @param {readonly Highlight[]} list
 */
export function withQuotes(text, list) {
  if (!list.length) return text;
  const q = list.map((h) => `${h.quote.split("\n").map((l) => `> ${l}`).join("\n")}${h.from ? `\n> — ${h.from}` : ""}`).join("\n\n");
  return `${q}\n\n${text}`;
}

/**
 * Whose words a selection is in: the message row it sits in names its author (`data-from`, set by the row). "" when it is in no row. @param {any} node a DOM node (text or element)
 * @returns {string}
 */
export function fromOfNode(node) {
  const e = node && (node.nodeType === 1 ? node : node.parentElement);
  const row = e && typeof e.closest === "function" ? e.closest("[data-from]") : null;
  return row ? String(row.getAttribute("data-from") || "").trim() : "";
}
