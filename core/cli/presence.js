// @ts-check
// presence: the CLI side of ADR 0004. A human-only tool answers `presence_required` until the
// call carries a yes (lib/one-yes.js). This file gets that yes: Touch ID when this is a Mac, else a code
// that vyred writes to our own terminal and the person types back, else the person's phone.
//
// The code is read from /dev/tty, never stdin, since stdin may be a pipe carrying JSON. A
// process with no controlling terminal (the model's Bash) cannot open /dev/tty, so it is refused
// here before any challenge is asked for. That refusal is a courtesy; vyred is what checks.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { call } from "../daemon/client.js";
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
const REUSE_OPS = ["vault.reveal", "vault.copy", "vault.totp"];
const PHONE_WAIT_MS = 5 * 60_000, PHONE_POLL_MS = 1500;
const wait = ms => new Promise(res => setTimeout(res, ms));

/**
 * Call a tool as the person at this terminal. A tool that needs your yes (one of the three moments: pairing or widening reach, a vault secret, an outward send) answers presence_required with
 * the exact request; the yes then goes the one way: ask a card for it (approvals.ask), confirm it HERE (Touch ID on a Mac, or the code Vyre writes to this terminal) or on your phone when this
 * server has no screen of its own, and call again with the approved card (x-vyre-approval). Returns the final { data } or { error }; any other error comes back as it is.
 * @param {string} tool
 * @param {any} [input]
 * @param {{ root?: string, io?: PresenceIO, tty?: boolean, timeout?: number, headers?: Record<string, string>, pollMs?: number }} [opts] headers go on the first call (a kernel proof the person made elsewhere)
 */
export async function callAsPerson(tool, input = {}, { root, io = realIO, timeout, headers, pollMs = PHONE_POLL_MS } = {}) {
  // root stays undefined unless given, so inside a session the client uses its VYRE_SOCKET.
  const t = timeout ? { timeout } : {};
  const r = await call(tool, input, { root, ...t, ...(headers ? { headers } : {}) });
  if (!needsProof(r)) return r;
  const { moment, request } = r.error;
  // A refusal that names no moment is not a yes to give (the tool is the person's own and this is not the person): say it as it is.
  if (!moment || !request) return r;

  // A terminal first: without one this is not a person at a prompt, and a confirmation the user did not ask for is one they might accept without reading.
  let fd, name;
  try { fd = io.openTty(); name = io.ttyName(fd); } catch {
    if (fd !== undefined) io.close?.(fd);
    return { error: { code: "no_terminal", message: NO_TERMINAL } };
  }
  try {
    const asked = await call("approvals.ask", { moment, request, ...(REUSE_OPS.includes(tool) ? { reuse: true } : {}) }, { root, ...t });
    if (asked.error) return asked;
    const id = asked.data.id;
    io.print(`  ${asked.data.line || "Waiting for your yes"}`);
    const again = () => call(tool, input, { root, ...t, headers: { ...(headers || {}), "x-vyre-approval": id } });
    let c = await call("approvals.local-yes", { id, tty: name }, { root, ...t });
    if (c.error && c.error.code === "presence_required") {
      // This computer cannot confirm it (a server has no screen of its own): the card is on your phone.
      io.print("  Approve it in Vyre on your phone...");
      const end = Date.now() + PHONE_WAIT_MS;
      while (Date.now() < end) {
        const s = await call("approvals.status", { id }, { root, ...t });
        if (s.error) return s;
        if (s.data.state === "approved") return again();
        if (s.data.state === "refused" || s.data.state === "none") return { error: { code: "presence_required", message: "that was not approved" } };
        await wait(pollMs);
      }
      return { error: { code: "presence_required", message: "nobody approved it in time; ask again" } };
    }
    if (c.error) return c;
    if (c.data && c.data.need === "code") {
      const challenge = c.data.challenge;
      for (let i = 0; i < TRIES; i++) {
        // Only the base64url alphabet can reach the request, so a stray space or = cannot change it.
        const code = (await io.prompt(fd, "  Type the code Vyre showed: ")).replace(/[^A-Za-z0-9_-]/g, "");
        c = await call("approvals.local-yes", { id, challenge, code }, { root, ...t });
        if (!c.error && c.data && c.data.answered === "approved") return again();
        if (i < TRIES - 1) io.print("  That code did not match. Try again.");
      }
      return c.error ? c : { error: { code: "presence_required", message: "that was not confirmed" } };
    }
    return c.data && c.data.answered === "approved" ? again() : { error: { code: "presence_required", message: "that was not confirmed" } };
  } finally {
    io.close?.(fd);
  }
}
