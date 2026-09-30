// @ts-check
// helper: computerd's address for vyred itself, without a screen (ADR 0005, decisions 3 and 4).
//
// Glass reads an agent's files through computerd, and the shield tells computerd to close its
// eyes. Neither needs a screen, so neither takes a checkout: the container is thawed (or made,
// or started) the way a checkout would, and then touched. A checked-out computer has its
// checkout touched; one nobody holds has its freeze clock restarted, so it freezes again a
// little after the last file request instead of right away.
//
// The token goes back to the module that asked, in memory. It is never logged, emitted or put
// in an error here.

import { NO_DRIVER } from "./pool.js";

/**
 * Thaw and touch the agent's computer without taking a screen, and say where computerd is.
 * @param {import("./pool.js").Pool} pool
 * @param {string} agent
 * @returns {Promise<{ url: string, token: string }>}
 */
export async function helper(pool, agent) {
  if (!pool.driver) throw new Error(NO_DRIVER);
  return pool.serial(agent, async () => {
    await pool.allowed(agent);
    await pool.ensure(agent);
    if (!pool.touch(agent)) pool.idle.set(agent, pool.now());
    return pool.endpoint(agent).helper;
  });
}

/**
 * Tell computerd to raise or lower its own shield (423 on its eyes and hands). Raising thaws
 * the computer; lowering never starts one that is not running, since a stopped computer's
 * computerd starts unshielded anyway. Throws when computerd cannot be told; the caller logs it
 * and the shield in vyred holds regardless.
 * @param {import("./pool.js").Pool} pool
 * @param {string} agent
 * @param {boolean} on
 * @param {{ reason?: string, fill_token?: string }} [o]
 * @returns {Promise<boolean>} whether computerd was told
 */
export async function tellComputerd(pool, agent, on, o = {}) {
  let h = null;
  if (on) h = await helper(pool, agent);
  else {
    const r = pool.row(agent);
    if (r && r.state === "running" && pool.hosts.has(agent)) h = pool.endpoint(agent).helper;
  }
  if (!h) return false;
  const res = await fetch(new URL("/shield", h.url), {
    method: "POST",
    headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
    // The fill token goes to computerd and nowhere else: never logged, emitted or put in an error.
    body: JSON.stringify({ on, ...(o.reason ? { reason: o.reason } : {}), ...(on && o.fill_token ? { fill_token: o.fill_token } : {}) }),
    signal: AbortSignal.timeout(3_000),
  });
  if (res.body) await res.body.cancel().catch(() => {});
  if (!res.ok) throw new Error(`computerd answered ${res.status}`);
  return true;
}
