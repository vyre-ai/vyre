// @ts-check
// The drawn Wink code (ADR 0043): the person's avatar inside two rings of ticks, drawn by the Deck's own renderer (lib/wink-code), so the app and the Deck draw one thing.
// The ring holds 8 bytes. Here they are the first 8 bytes of a hash of the code's text, so one code always draws the same picture and two codes never do. Pure: no DOM, no React.
import { sha256 } from "@noble/hashes/sha256";
import { renderCode2, bitsToLevels } from "../../../../lib/wink-code/vyrecode2.js";
import { buildCodeword, bytesToBits } from "../../../../lib/wink-code/payload.js";
import { USER_GRADIENTS } from "../../../../lib/wink-code/identity.js";

/** The kinds of Wink a screen shows, each with its own words, colour and glyph around the drawing (team/0.3/PRODUCT-connections.md section 2). */
export const KINDS = /** @type {const} */ ({
  device: { words: () => "Add your device", glyph: "plus", tone: "accent" },
  join: { words: (/** @type {string} */ space) => `Join ${space}`, glyph: "share", tone: "ok" },
});

/** The 8 bytes a code's ring holds. @param {string} text @returns {number[]} */
export function ringBytes(text) {
  return Array.from(sha256(new TextEncoder().encode(String(text)))).slice(0, 8);
}

/** The SVG of a code. @param {string} text @param {{ scheme?: "dark" | "paper", size?: number }} [o] */
export function winkCodeSvg(text, o = {}) {
  const bytes = ringBytes(text);
  return renderCode2(bitsToLevels(bytesToBits(buildCodeword(bytes))), { userOption: bytes[0] % USER_GRADIENTS.length, style: "ticksSunburst", theme: o.scheme === "paper" ? "paper" : "dark", size: o.size ?? 220 });
}
