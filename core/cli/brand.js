// @ts-check
// The Vyre mark in a terminal: the "v" stroke and its lime dot from the icon (deck/favicon.svg),
// as two characters, "v•". Plain "v·" without colour, so a pipe or NO_COLOR still reads it.

import { painters } from "./style.js";

/** The mark for a stream. @param {{ isTTY?: boolean }} [stream] */
export function mark(stream = process.stdout) {
  const p = painters(stream);
  return p.on ? `\x1b[1;38;2;241;238;230mv\x1b[0m${p.signal("•")}` : "v·";
}

/**
 * The first lines a person sees: the mark, the name, the version and commit.
 * @param {{ version: string, commit?: string | null, dirty?: boolean | null }} b
 * @param {{ isTTY?: boolean }} [stream]
 */
export function hello(b, stream = process.stdout) {
  const p = painters(stream);
  const v = b.commit ? `${b.version} · ${b.commit.slice(0, 7)}${b.dirty ? "+dirty" : ""}` : b.version;
  return `  ${mark(stream)}  ${p.bold("Vyre is installed")} ${p.dim("· " + v)}`;
}
