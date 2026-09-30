// @ts-check
// Terminal colour, from the brand tokens. Plain text when stdout is not a terminal, so piping
// `vyre` into anything gets clean output. NO_COLOR turns colour off, TERM=dumb too, and
// FORCE_COLOR (anything but "0") turns it on even into a pipe, unless NO_COLOR is set. Every
// command colours through this file and nothing else.

import { ATTENTION } from "../config/palette.js";

/**
 * Whether a stream gets colour.
 * @param {{ isTTY?: boolean }} [stream]
 * @param {Record<string, string|undefined>} [env]
 */
export function colorOn(stream = process.stdout, env = process.env) {
  // NO_COLOR wins over FORCE_COLOR: a test runner may force colour for every child it starts,
  // and a caller that said no colour means it.
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return env.FORCE_COLOR !== "0";
  if (env.TERM === "dumb") return false;
  return Boolean(stream && stream.isTTY);
}

/**
 * The painters for one stream: stdout's are the exports below; stderr gets its own, since one
 * may be a terminal while the other is a pipe.
 * @param {{ isTTY?: boolean }} stream
 */
/** @param {string} hex "#RRGGBB" @returns {[number, number, number]} */
function hexRgb(hex) {
  return /** @type {[number, number, number]} */ ([1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
}

export function painters(stream) {
  const on = colorOn(stream);
  const sgr = code => s => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  const rgb = (r, g, b) => sgr(`38;2;${r};${g};${b}`);
  return {
    on,
    dim: sgr("2"),
    bold: sgr("1"),
    /** Focus and primary action. */
    signal: rgb(198, 243, 107),
    /** Anything that came from memory rather than a model. */
    recall: rgb(235, 199, 107),
    /** Needs the user. Nothing else uses it. The attention colour, from core/config/palette.js. */
    beacon: rgb(...hexRgb(ATTENTION.violet.dark)),
  };
}

const std = painters(process.stdout);
const tty = std.on;

export const dim = std.dim;
export const bold = std.bold;
/** Focus and primary action. */
export const signal = std.signal;
/** Anything that came from memory rather than a model. */
export const recall = std.recall;
/** Needs the user. Nothing else uses it. */
export const beacon = std.beacon;
/** Whether stdout gets colour. */
export const colour = tty;
/** The painters for stderr. */
export const err = painters(process.stderr);
export const out = (...a) => console.log(...a);

/** Text without its colour codes: for measuring width, and for tests. */
export const strip = s => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
