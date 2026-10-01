// @ts-check
// identity: the OS user a sandboxed child runs as. On a box, vyre-core creates a user with no
// login and the host firewall rejects every outbound connection from that uid (an iptables
// `-m owner --uid-owner` REJECT, installed by the box image), so a child cannot reach the
// network, the tailnet or a loopback service except through its parent's mediated fetch. The
// uid is not a Vyre secret; the boundary is the firewall rule, and IM1 in the plan tests it.
// Where vyred is not root (the person's Mac, a dev shell) no other uid can be taken: `uid` is
// null, `isolated` is false, and the sandbox is the Node permission model plus mediated fetch only.

import { execFileSync } from "node:child_process";

/**
 * @param {{ env?: Record<string, string|undefined>, getuid?: () => number, lookup?: (name: string) => number|null }} [o]
 * @returns {{ uid: number|null, gid: number|null, isolated: boolean, why: string }}
 */
export function sandboxIdentity({ env = process.env, getuid = () => process.getuid?.() ?? -1, lookup = idOf } = {}) {
  if (getuid() !== 0) return { uid: null, gid: null, isolated: false, why: "vyred is not root, so the child runs as the same user" };
  const name = env.VYRE_SANDBOX_USER || "vyre-sandbox";
  const uid = env.VYRE_SANDBOX_UID ? Number(env.VYRE_SANDBOX_UID) : lookup(name);
  if (!Number.isInteger(uid) || /** @type {number} */ (uid) <= 0) return { uid: null, gid: null, isolated: false, why: `no ${name} user on this machine` };
  return { uid: /** @type {number} */ (uid), gid: /** @type {number} */ (uid), isolated: true, why: `runs as ${name}` };
}

/** @param {string} name */
function idOf(name) {
  try { const n = Number(execFileSync("id", ["-u", name], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim()); return Number.isInteger(n) ? n : null; }
  catch { return null; }
}
