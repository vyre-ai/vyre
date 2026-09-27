// @ts-check
// presence: the CLI side of ADR 0004. A human-only tool answers `presence_required` until the
// call carries a proof that a person is here. This file gets that proof: Touch ID when vyred
// offers it, else a code that vyred writes to our own terminal and the person types back.
//
// The code is read from /dev/tty, never stdin, since stdin may be a pipe carrying JSON. A
// process with no controlling terminal (the model's Bash) cannot open /dev/tty, so it is refused
// here before any challenge is asked for. That refusal is a courtesy; vyred is what checks.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { request, call } from "../daemon/client.js";
import * as config from "../config/index.js";

export const NO_TERMINAL = "this needs a person at a terminal; run it in your own terminal";
const TRIES = 3;

/**
 * @typedef {{ openTty(): number, ttyName(fd: number): string, prompt(fd: number, text: string): Promise<string>,
 *   print(text: string): void, close?(fd: number): void }} PresenceIO
 */

/** @type {PresenceIO} */
export const realIO = {
  openTty: () => fs.openSync("/dev/tty", "r+"),
  ttyName: fd => execFileSync("tty", { stdio: [fd, "pipe", "ignore"] }).toString().trim(),
  prompt: async (fd, text) => {
    fs.writeSync(fd, text);
    const buf = Buffer.alloc(1);
    let line = "";
    while (fs.readSync(fd, buf, 0, 1, null) === 1 && buf[0] !== 10) line += String.fromCharCode(buf[0]);
    return line;
  },
  print: text => { process.stderr.write(text + "\n"); },
  close: fd => { try { fs.closeSync(fd); } catch {} },
};

const needsProof = r => r?.error?.code === "presence_required";

/**
 * Call a tool as the person at this terminal. Returns the final { data } or { error }; any
 * error other than presence_required comes back as it is.
 * @param {string} tool
 * @param {any} [input]
 * @param {{ root?: string, io?: PresenceIO, tty?: boolean, timeout?: number }} [opts] tty forces the terminal method.
 */
export async function callAsPerson(tool, input = {}, { root = config.home(), io = realIO, tty = false, timeout } = {}) {
  const t = timeout ? { timeout } : {};
  const as = (/** @type {string} */ proof) => call(tool, input, { root, ...t, headers: { "x-vyre-presence": proof } });
  let r = await call(tool, input, { root, ...t });
  if (!needsProof(r)) return r;
  const methods = r.error.methods || [];

  // A terminal first, for every method: without one this is not a person at a prompt, and a
  // Touch ID dialog the user did not ask for is one they might accept without reading.
  let fd, name;
  try { fd = io.openTty(); name = io.ttyName(fd); } catch {
    if (fd !== undefined) io.close?.(fd);
    return { error: { code: "no_terminal", message: NO_TERMINAL } };
  }
  try {
    if (!tty && methods.includes("touchid")) {
      io.print("  Confirm on this Mac (Touch ID or password)...");
      return await as("touchid");
    }
    if (!methods.includes("tty")) {
      return { error: { ...r.error, message: `${tool} needs presence by ${methods.join(" or ") || "a method"} this terminal cannot give` } };
    }
    const c = await request("POST", "/v1/presence/challenge", { tool, input, method: "tty", tty: name }, { root });
    if (c.error) return c;
    const id = c.data.challenge;
    for (let i = 0; i < TRIES; i++) {
      // Only the base64url alphabet can reach the header, so a stray space or = cannot split it.
      const code = (await io.prompt(fd, "  Type the code Vyre showed: ")).replace(/[^A-Za-z0-9_-]/g, "");
      r = await as(`tty id=${id} code=${code}`);
      if (!needsProof(r)) return r;
      if (i < TRIES - 1) io.print("  That code did not match. Try again.");
    }
    return r;
  } finally {
    io.close?.(fd);
  }
}
