// @ts-check
// confirm: a person at a terminal types an id back before a human-only learn tool runs.
//
// STOPGAP until ADR 0004's presence registry lands. The human-only learn tools (accept, retire,
// relax, skill-install, skill-retire, skill-dismiss) declare `presence`, but main's registry does
// not enforce it yet, and any process of this user can claim the `cli` caller. So the CLI checks
// for itself that a person is there: stdin and stdout are terminals, AND /dev/tty opens. Claude
// Code's Bash tool starts its shell with no controlling terminal, so opening /dev/tty there fails
// with ENXIO (ADR 0004, "What Claude Code gives a Bash command"). Then the person types the id back
// on /dev/tty.
//
// This is a claim the CLI makes about itself, not a proof: `script` or a hand-written client gets
// round it. The floor's guards (checks.js weakens()) ask before a model's Bash runs any of those
// routes, and ADR 0004's registry, checked by vyred, is the real answer. When core/presence exists
// (the verifier is installed), vyred checks presence itself and this step is skipped.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HUMAN_TOOLS } from "../learn/checks.js";

export { HUMAN_TOOLS };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Is ADR 0004's presence verifier installed? Then vyred checks presence and the CLI need not. */
export const verifier = () => fs.existsSync(path.join(HERE, "..", "presence", "index.js"));

/** One line from a terminal file descriptor, read a byte at a time (no stdin buffering in the way). */
function readLine(fd) {
  const b = Buffer.alloc(1);
  let s = "";
  for (;;) {
    const n = fs.readSync(fd, b, 0, 1, null);
    if (!n) break;
    const ch = b.toString("utf8");
    if (ch === "\n") break;
    s += ch;
    if (s.length > 200) break;
  }
  return s.replace(/\r$/, "");
}

/** The real terminal. Tests pass their own. */
export function terminal() {
  return {
    verifier,
    isTTY: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    open: () => {
      const fd = fs.openSync("/dev/tty", "r+");
      return { write: s => { fs.writeSync(fd, s); }, readLine: () => readLine(fd), close: () => fs.closeSync(fd) };
    },
  };
}

const NOT_HERE = "needs you at a terminal: it asks you to type the id back, which a script or Claude's shell cannot do.";

/**
 * Ask the person at the terminal to type `token` back after reading `summary`.
 * @param {{ token: string|number, summary: string, what: string }} ask
 * @param {{ verifier: () => boolean, isTTY: () => boolean, open: () => { write(s: string): void, readLine(): string, close(): void } }} [io]
 * @returns {{ ok: true, via: "presence"|"tty" } | { ok: false, why: string }}
 */
export function confirm({ token, summary, what }, io = terminal()) {
  if (io.verifier()) return { ok: true, via: "presence" };
  if (!io.isTTY()) return { ok: false, why: `${what} ${NOT_HERE}` };
  let tty;
  try { tty = io.open(); } catch { return { ok: false, why: `${what} ${NOT_HERE}` }; }
  try {
    tty.write(`  ${summary}\n  Type ${token} to confirm: `);
    const typed = tty.readLine().trim();
    return typed === String(token) ? { ok: true, via: "tty" } : { ok: false, why: `${what} not confirmed: you typed ${JSON.stringify(typed.slice(0, 20))}, not ${token}.` };
  } finally { try { tty.close(); } catch {} }
}
