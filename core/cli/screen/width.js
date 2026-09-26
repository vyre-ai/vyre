// @ts-check
// How wide text is on a terminal, and how to cut it to fit. The screen never lets a line wrap:
// a wrapped line pushes every row under it down one and the diff redraw then paints over the
// wrong rows. So every row is measured in columns, not characters: CJK and most emoji take two,
// combining marks and joiners take none.
//
// The count errs wide. A ZWJ emoji sequence counts each part, so it is cut a little early rather
// than drawn a column past the edge.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Text without escape sequences. */
export const stripAnsi = s => String(s ?? "").replace(ANSI, "");

/**
 * Text that is safe to draw: escape sequences and control characters out, tabs as spaces.
 * Anything a model, a transcript or a draft says goes through this first, so no output can move
 * the cursor, retitle the window or switch the terminal's mode.
 * @param {string} s @param {{ newlines?: boolean }} [o] newlines: keep \n
 */
export function sanitize(s, { newlines = false } = {}) {
  const t = stripAnsi(s).replace(/\t/g, "  ").replace(/\r\n?/g, "\n");
  return newlines ? t.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "") : t.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Columns one code point takes. */
export function charWidth(cp) {
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff)
    || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)
    || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x231a && cp <= 0x231b) || (cp >= 0x23e9 && cp <= 0x23ec) || cp === 0x23f0 || cp === 0x23f3
    || (cp >= 0x25fd && cp <= 0x25fe) || (cp >= 0x2614 && cp <= 0x2615) || (cp >= 0x2648 && cp <= 0x2653) || cp === 0x267f || cp === 0x2693
    || cp === 0x26a1 || (cp >= 0x26aa && cp <= 0x26ab) || (cp >= 0x26bd && cp <= 0x26be) || (cp >= 0x26c4 && cp <= 0x26c5) || cp === 0x26ce
    || cp === 0x26d4 || cp === 0x26ea || (cp >= 0x26f2 && cp <= 0x26f3) || cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || cp === 0x2705
    || (cp >= 0x270a && cp <= 0x270b) || cp === 0x2728 || cp === 0x274c || cp === 0x274e || (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757
    || (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf || (cp >= 0x2b1b && cp <= 0x2b1c) || cp === 0x2b50 || cp === 0x2b55
    || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xa960 && cp <= 0xa97f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f004 && cp <= 0x1f0cf) || (cp >= 0x1f18e && cp <= 0x1f19a) || (cp >= 0x1f200 && cp <= 0x1f251)
    || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f7e0 && cp <= 0x1f7eb)
    || (cp >= 0x1f900 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

/** Columns a string takes, escape sequences not counted. */
export function width(s) {
  let n = 0;
  for (const ch of stripAnsi(s)) n += charWidth(/** @type {number} */ (ch.codePointAt(0)));
  return n;
}

/**
 * Plain text cut to at most `cols` columns, with an ellipsis when something was cut.
 * @param {string} s plain text (no escape sequences) @param {number} cols
 */
export function clip(s, cols) {
  const t = String(s ?? "");
  if (cols <= 0) return "";
  if (width(t) <= cols) return t;
  let out = "", n = 0;
  for (const ch of t) {
    const w = charWidth(/** @type {number} */ (ch.codePointAt(0)));
    if (n + w > cols - 1) break;
    out += ch; n += w;
  }
  return out + "…";
}

/** Plain text cut or padded to exactly `cols` columns. */
export function fit(s, cols) {
  const c = clip(s, cols);
  return c + " ".repeat(Math.max(0, cols - width(c)));
}

/**
 * Plain text broken into lines of at most `cols` columns, at spaces where it can be.
 * @returns {string[]}
 */
export function wrap(s, cols) {
  const lines = [];
  for (const para of String(s ?? "").split("\n")) {
    if (cols <= 1) { lines.push(clip(para, cols)); continue; }
    let line = "", n = 0;
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const w = width(word);
      if (n + w <= cols) { line += word; n += w; continue; }
      if (/^\s+$/.test(word)) { lines.push(line); line = ""; n = 0; continue; }
      if (line.trim()) { lines.push(line.replace(/\s+$/, "")); line = ""; n = 0; }
      // A word longer than the line is split where it has to be.
      for (const ch of word) {
        const cw = charWidth(/** @type {number} */ (ch.codePointAt(0)));
        if (n + cw > cols) { lines.push(line); line = ""; n = 0; }
        line += ch; n += cw;
      }
    }
    lines.push(line);
  }
  return lines;
}
