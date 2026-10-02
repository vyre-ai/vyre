// @ts-check
// ending: the block the Mac's terminal ends with (ADR 0008 section 6). `vyre server add` prints it
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
    // Ready means the address serves: without it, the phone and the Mac have nothing to reach.
    address ? "  Vyre is ready." : "  Almost there: your server has no address yet.",
    "",
    `    your server     ${address || "not set up yet"}`,
    // Not a dead end: the one command that makes it.
    assistant ? `    your assistant  ${assistant}` : "    your assistant  none yet: vyre assistant <name>, e.g. vyre assistant Juno",
    "    next            vyre      (your projects and threads)",
  ];
}

/** Print the ending with a blank line either side. */
export function printEnding(info) {
  out("");
  for (const l of ending(info)) out(l);
  out("");
}
