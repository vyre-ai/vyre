// @ts-check
// A QR code for a terminal, with no dependency and no network call: the encoder is the vendored qrcode-generator (./vendor, pinned in
// vendor/PINS-qr.json, MIT). Used by the box to draw the pairing QR that i.sh prints, so a phone can pair a server by scanning it. The QR
// carries a long secret (see core/wink/pairing.js, wink.server.code with qr), so it needs no PAKE.
//
// The art is plain text of four glyphs, two QR rows per text row, and says nothing about colour: ' ' is light over light, the upper half
// block is dark over light, the lower half block is light over dark, the full block is dark over dark. A caller that wants it to scan on
// any terminal theme prints it as black on white (ESC[30;47m ... ESC[0m); i.sh does.

import qrcode from "./vendor/qrcode-generator.js";

/**
 * The module matrix of a QR code for some ASCII text. Error correction M, version chosen by the encoder.
 * @param {string} text printable ASCII only
 * @returns {boolean[][]} rows of modules, true for dark
 */
export function qrMatrix(text) {
  if (typeof text !== "string" || !text || !/^[\x20-\x7e]+$/.test(text)) throw new Error("a QR payload is printable ASCII");
  if (text.length > 200) throw new Error("a QR payload here is at most 200 characters");
  const q = qrcode(0, "M");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

/**
 * The text rows of a QR code, with a quiet zone of `quiet` light modules on every side.
 * @param {string} text @param {{ quiet?: number }} [o]
 * @returns {string[]}
 */
export function qrLines(text, o = {}) {
  const quiet = o.quiet ?? 2;
  const m = qrMatrix(text);
  const n = m.length + 2 * quiet;
  const dark = (/** @type {number} */ r, /** @type {number} */ c) => { const rr = r - quiet, cc = c - quiet; return rr >= 0 && cc >= 0 && rr < m.length && cc < m.length && m[rr][cc]; };
  const out = [];
  for (let r = 0; r < n; r += 2) {
    let line = "";
    for (let c = 0; c < n; c++) {
      const t = dark(r, c), b = r + 1 < n && dark(r + 1, c);
      line += t ? (b ? "█" : "▀") : (b ? "▄" : " ");
    }
    out.push(line);
  }
  return out;
}

/** The art as one string. @param {string} text @param {{ quiet?: number }} [o] */
export const qrArt = (text, o) => qrLines(text, o).join("\n");
