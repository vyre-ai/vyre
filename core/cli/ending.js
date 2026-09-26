// @ts-check
// ending — the block the Mac's terminal ends with (ADR 0008 section 6). `vyre box add` prints it
// when onboarding finishes and `vyre up` prints it every time after, so "is it done?" always has
// the same answer in the same words.

import { out } from "./style.js";

/**
 * The ending as plain lines, no colour, so tests and callers can compare it exactly.
 * @param {{ address?: string|null, assistant?: string|null }} info
 * @returns {string[]}
 */
export function ending({ address, assistant }) {
  return [
    "  Vyre is ready.",
    "",
    `    your box        ${address || "not set up yet"}`,
    `    your assistant  ${assistant || "not set up yet"}`,
    "    next            vyre      (your projects and threads)",
  ];
}

/** Print the ending with a blank line either side. */
export function printEnding(info) {
  out("");
  for (const l of ending(info)) out(l);
  out("");
}
