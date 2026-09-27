// @ts-check
// A QR code in the terminal: the matrix from the vendored qrcode-generator (deck/vendor/qrcode.js,
// MIT, all 40 versions, the one the Deck draws with), drawn as half blocks. One encoder for the
// Deck, `vyre phone add` and `vyre relay pair`: a relay pair URL (about 200 to 260 characters)
// needs more than version 10.

import qrcode from "../../deck/vendor/qrcode.js";

/**
 * The QR code for a text, level M, byte mode (UTF-8): rows of booleans, true for a dark module,
 * without the quiet zone. The smallest version that holds it.
 * @param {string} text
 * @returns {boolean[][]}
 */
export function qr(text) {
  const q = qrcode(0, "M");
  // The encoder's byte mode takes one byte per character: UTF-8 bytes as latin1 go through intact.
  q.addData(Buffer.from(String(text), "utf8").toString("latin1"), "Byte");
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => Boolean(q.isDark(y, x))));
}

/**
 * The code as terminal lines, two modules per character cell, with a quiet zone. Explicit black
 * and white, so it scans the same on a dark terminal and a light one.
 * @param {boolean[][]} m
 * @param {{ quiet?: number, indent?: string }} [o]
 * @returns {string[]}
 */
export function terminal(m, { quiet = 2, indent = "  " } = {}) {
  const n = m.length + quiet * 2;
  const dark = (x, y) => { x -= quiet; y -= quiet; return y >= 0 && y < m.length && x >= 0 && x < m.length && m[y][x]; };
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let s = indent;
    for (let x = 0; x < n; x++) {
      // The upper half block in the top module's colour, on the bottom module's colour.
      s += `\x1b[${dark(x, y) ? 30 : 97};${y + 1 < n && dark(x, y + 1) ? 40 : 107}m▀`;
    }
    lines.push(s + "\x1b[0m");
  }
  return lines;
}
