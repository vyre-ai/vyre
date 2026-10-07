// @ts-check
// The one way out of a session on the person's own computer (reviewer-2, Mac gap 3): a per-session egress proxy in internet mode, public addresses only (core/runner/egress.js and
// netguard.js: loopback, private, link-local, carrier-grade NAT including tailnet addresses, multicast and this machine's own addresses are refused; the proxy resolves the name itself and
// connects to the address it checked; no mail ports). macOS: a loopback port, the only network the seatbelt profile allows. Linux: a unix socket bound into the sandbox, with the in-sandbox shim.
// The session token is the proxy password, so another program of the same user that finds the port cannot use it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createEgress } from "./egress.js";

/**
 * @param {{ platform?: string, dir?: string, lookup?: any, dial?: any, onEvent?: (e: any) => void }} [o] `lookup` and `dial` are test seams (a stub resolver and dialer).
 * @returns {Promise<{ proxy: { port?: number, socket?: string, token: string }, stop: () => Promise<void> }>}
 */
export async function startHomeProxy(o = {}) {
  const platform = o.platform || process.platform;
  const token = crypto.randomBytes(18).toString("hex");
  const eg = createEgress({ routes: [], vault: {}, session: "home", token, internet: true, lookup: o.lookup, dial: o.dial, onEvent: o.onEvent });
  /** @type {string | null} */ let dir = null;
  const where = platform === "linux" ? { socket: path.join((dir = fs.mkdtempSync(path.join(o.dir ? (fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 }), o.dir) : os.tmpdir(), "vyre-eg-"))), "egress.sock") } : {};
  if (dir) fs.chmodSync(dir, 0o700);
  const r = await eg.listen(where);
  return { proxy: { ...r, token }, async stop() { await eg.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); } };
}
