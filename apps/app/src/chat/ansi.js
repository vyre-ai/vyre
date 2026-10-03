// @ts-check
// ANSI colour output for the terminal block: SGR colours (30-37, 90-97), bold, dim, reset. Every
// other escape sequence is dropped. Pure. A span is { text, fg, bold, dim }; fg is a palette slot
// name the component maps to the theme, never a hex.

/** @typedef {{ text: string, fg: string | null, bold: boolean, dim: boolean }} Span */
const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** @param {string} input @returns {Span[]} */
export function parseAnsi(input) {
  /** @type {Span[]} */ const out = [];
  let fg = /** @type {string | null} */ (null), bold = false, dim = false;
  const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r(?!\n)/g;
  let at = 0;
  /** @param {string} s */
  const push = (s) => { if (s) out.push({ text: s, fg, bold, dim }); };
  for (let m; (m = re.exec(input)); ) {
    push(input.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[2] !== "m") continue;
    const codes = (m[1] || "0").split(";").map((n) => Number(n) || 0);
    for (const c of codes) {
      if (c === 0) { fg = null; bold = false; dim = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c === 39) fg = null;
      else if (c >= 30 && c <= 37) fg = NAMES[c - 30];
      else if (c >= 90 && c <= 97) fg = NAMES[c - 90];
    }
  }
  push(input.slice(at));
  return out;
}

/** Plain text, for copy. @param {string} input */
export const stripAnsi = (input) => parseAnsi(input).map((s) => s.text).join("");
