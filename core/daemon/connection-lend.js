// @ts-check
// core/daemon/connection-lend.js: the connections a woken agent borrows for one job. The Flows host calls these from the agent wake
// (core/daemon/agent-wake.js): lend when the task starts, end when it closes. The vault decides; this only names who approved and what.

/**
 * Lend the connections the approved Kit names for a task to the agent doing it, and only when a person approved the task: that person must
 * hold each connection (the vault refuses otherwise). The approver is read from the task's assigned_by here, never from an agent's or
 * a member's input. With no approver nothing is lent and the agent runs on its own access.
 * @param {{ callModule?: (tool: string, input: any) => Promise<any>, clock: () => number }} o
 * With a `thread`, the lease is held to that job's thread (the unbound one ends in the same step).
 * @param {any} t the task @param {string} [thread]
 */
export async function lendConnections(o, t, thread) {
  const approver = t.assigned_by && t.assigned_by.kind === "person" ? String(t.assigned_by.id) : "";
  if (!approver || !o.callModule) return;
  let named;
  try { named = await o.callModule("flows.kit.credentials", { task: String(t.id) }); } catch { return; }   // no approved Kit version names credentials for it: nothing to lend
  if (!named || !Array.isArray(named.credentials) || !named.credentials.length) return;
  await o.callModule("vault.connections.lend", { task: String(t.id), agent: String(t.doer.id), connections: named.credentials, until: o.clock() + 24 * 3600 * 1000, approver, ...(thread ? { thread } : {}) });
}

/** End whatever was lent for a task that closed or expired. @param {{ callModule?: (tool: string, input: any) => Promise<any> }} o @param {string} id */
export async function endConnections(o, id) {
  if (!o.callModule) return;
  try { await o.callModule("vault.connections.end", { task: String(id), reason: "the task is over" }); } catch { /* none was lent */ }
}
