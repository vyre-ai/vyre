// @ts-check
// The composer's predictive text (ADR 0036, "3. suggest"), with no DOM, so the Deck and the app
// share it: what to ask suggest.query, which rows to show, what a pick puts in the text, and what
// suggest.picked is told. The box ranks; this only checks what came back and applies it.

/** Kinds the chat composer shows; the Capsule's own (times, accounts) are left to it. */
const SHOWN = new Set(["mention", "command", "entity", "phrase", "file"]);

/**
 * suggest.query's input for the text and caret.
 * @param {string} text @param {number} cursor
 */
export const queryInput = (text, cursor) => ({ text: String(text ?? ""), cursor: Math.max(0, Math.min(Number(cursor) || 0, String(text ?? "").length)), surface: "chat" });

/**
 * The token at the caret, by suggest's own rule (the run of non-space characters before it).
 * @param {string} text @param {number} cursor
 */
export function tokenBefore(text, cursor) {
  const s = String(text ?? "");
  const end = Math.max(0, Math.min(Number.isInteger(cursor) ? cursor : s.length, s.length));
  const token = /(\S*)$/u.exec(s.slice(0, end))?.[1] ?? "";
  return { start: end - token.length, end, token };
}

/**
 * The rows worth showing from suggest.query's answer: each has a label, a string insert, a source
 * and an id, and is a kind the composer shows. At most `limit`.
 * @param {any} data @param {number} [limit]
 * @returns {{ kind: string, sub?: string, label: string, insert: string, detail?: string, source: string, id: string, score: number }[]}
 */
export function suggestRows(data, limit = 8) {
  const items = data && Array.isArray(data.items) ? data.items : [];
  const out = [];
  for (const x of items) {
    if (!x || typeof x.label !== "string" || !x.label || typeof x.insert !== "string" || typeof x.source !== "string" || typeof x.id !== "string") continue;
    if (!SHOWN.has(String(x.kind))) continue;
    out.push({ kind: String(x.kind), ...(x.sub ? { sub: String(x.sub) } : {}), label: x.label.slice(0, 200), insert: x.insert.slice(0, 2000),
      ...(x.detail ? { detail: String(x.detail).slice(0, 200) } : {}), source: x.source, id: x.id, score: Number(x.score) || 0 });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A picked row in the text: its insert replaces the token at the caret, and a space follows
 * unless one is already there; the caret lands after it. Returns the new text and caret.
 * @param {string} text @param {number} cursor @param {{ insert: string }} row
 */
export function applySuggestion(text, cursor, row) {
  const s = String(text ?? "");
  const { start, end } = tokenBefore(s, cursor);
  const after = s.slice(end);
  const pad = after.startsWith(" ") ? "" : " ";
  const next = s.slice(0, start) + row.insert + pad + after;
  // The caret lands after the space, ready for the next word.
  return { text: next, caret: start + row.insert.length + 1 };
}

/** What suggest.picked is told about a row. @param {{ kind: string, source: string, id: string }} row */
export const pickedInput = row => ({ kind: row.kind, source: row.source, id: row.id });
