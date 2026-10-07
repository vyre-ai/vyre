// @ts-check
// other-vpn: does this machine already run a VPN of the person's own that Wink must stay out of (ruling D4, 4 Oct 2026)?
//
// Wink never touches a system route or a resolver, so the only thing it can do about another VPN is not to start a node of its own and
// carry the link through the relay. This answers the question and nothing else: a read of the other client's status, never a write.
// A machine with no such client, and every test (the check is gated off under node --test), answers false.

import { execFile } from "node:child_process";

/** @param {string[]} args @param {{ timeout?: number }} [opts] @returns {Promise<{ code: number, out: string, err: string }>} */
function defaultRun(args, opts = {}) {
  return new Promise(resolve => {
    if (process.env.NODE_TEST_CONTEXT) return resolve({ code: 127, out: "", err: "gated off under test" });
    execFile(process.env.VYRE_OTHER_VPN_BIN || "tailscale", args, { timeout: opts.timeout || 1500, maxBuffer: 1 << 20 },
      (e, out, err) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 127) : 0, out: String(out || ""), err: String(err || "") }));
  });
}

/**
 * @param {{ run?: (args: string[], opts?: { timeout?: number }) => Promise<{ code: number, out: string, err: string }> }} [deps]
 * @returns {Promise<boolean>} true when another VPN client on this machine is running
 */
export async function otherVpnRunning(deps = {}) {
  const run = deps.run || defaultRun;
  try {
    const r = await run(["status", "--json"], { timeout: 1500 });
    if (r.code !== 0) return false;
    const j = JSON.parse(r.out);
    return Boolean(j) && j.BackendState === "Running";
  } catch { return false; }
}
