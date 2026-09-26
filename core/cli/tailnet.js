// @ts-check
// tailnet — what the person's own computer can see of their tailnet, read-only (ADR 0008).
//
// `vyre up` and `vyre box` use it on the Mac to check it is signed in, and to say why a box does
// not answer. Finding the box among the peers is the link module's `link.find`. It only ever runs `tailscale status --json`: Vyre never changes a Mac's Tailscale
// state. VYRE_TAILSCALE_BIN points tests at a fake; otherwise the CLI on PATH, then the one inside
// the Mac app (which acts as the CLI when TAILSCALE_BE_CLI=1).

import fs from "node:fs";
import { execFile } from "node:child_process";

const MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const CANDIDATES = ["tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];

export const DOWNLOAD = "https://tailscale.com/download";

/** Run `tailscale status --json` with one binary; 127 when it is not there. */
function statusWith(bin, env) {
  return new Promise(resolve => {
    execFile(bin, ["status", "--json"], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env }, (e, out, err) => {
      const code = !e ? 0 : /** @type {any} */ (e).code === "ENOENT" ? 127 : Number(/** @type {any} */ (e).code) || 1;
      resolve({ code, out: String(out), err: String(err) });
    });
  });
}

/**
 * ssh: the peer runs Tailscale SSH (its status carries sshHostKeys), so `ssh user@<its MagicDNS name>`
 * reaches it with the tailnet's own identity instead of a key or password.
 * @typedef {{ dnsName: string, hostName: string, ips: string[], online: boolean, userId: string, tagged: boolean, os: string, ssh: boolean }} Peer
 * @typedef {{ installed: boolean, running: boolean, backend: string|null, login: string|null, userId: string|null,
 *   self: { dnsName: string, hostName: string, ips: string[] } | null, peers: Peer[], why: string|null }} Tailnet
 */

/** @returns {Promise<Tailnet>} */
export async function status(env = process.env) {
  const bins = env.VYRE_TAILSCALE_BIN ? [env.VYRE_TAILSCALE_BIN] : [...CANDIDATES, ...(fs.existsSync(MAC_APP) ? [MAC_APP] : [])];
  for (const bin of bins) {
    const r = await statusWith(bin, bin === MAC_APP ? { ...env, TAILSCALE_BE_CLI: "1" } : env);
    if (r.code === 127) continue;
    try { return parse(JSON.parse(r.out)); }
    catch { return { ...none(true), why: (r.err || r.out).trim().split("\n")[0] || "tailscale status failed" }; }
  }
  return { ...none(false), why: "Tailscale is not installed" };
}

/** @returns {Tailnet} */
function none(installed) {
  return { installed, running: false, backend: null, login: null, userId: null, self: null, peers: [], why: null };
}

const trim = s => String(s || "").replace(/\.$/, "");

/** Pure, for tests: the fields Vyre reads from `tailscale status --json`. */
export function parse(s) {
  const running = s.BackendState === "Running";
  const self = s.Self || null;
  const userId = self && self.UserID != null ? String(self.UserID) : null;
  const users = s.User || {};
  const peers = Object.values(s.Peer || {}).map(p => ({
    dnsName: trim(p.DNSName), hostName: String(p.HostName || ""), ips: p.TailscaleIPs || [], online: Boolean(p.Online),
    userId: String(p.UserID ?? ""), tagged: Boolean(p.Tags && p.Tags.length), os: String(p.OS || ""),
    ssh: Array.isArray(p.sshHostKeys) && p.sshHostKeys.length > 0,
  }));
  return {
    installed: true, running, backend: s.BackendState || null,
    login: userId && users[userId] ? users[userId].LoginName || null : null,
    userId,
    self: self ? { dnsName: trim(self.DNSName), hostName: String(self.HostName || ""), ips: self.TailscaleIPs || [] } : null,
    peers,
    why: running ? null : s.BackendState === "NeedsLogin" ? "Tailscale is signed out: open Tailscale and sign in" : `Tailscale is ${s.BackendState || "not running"}`,
  };
}

/** Does a Vyre box answer at this https address? Resolves to its health, or null. */
export async function probe(address, ms = 4000) {
  try {
    const r = await fetch(address.replace(/\/$/, "") + "/v1/health", { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.data ? j.data : j;
  } catch { return null; }
}
