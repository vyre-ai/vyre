// @ts-check
// An agent's own watcher (core/watchers, owner kind agent) uses what is lent to its agent, with no grant of its own: the item must be one the agent may read right now by its standing
// kernel grant (never a lease held to a conversation). Only the watchers module asks, for a named watcher. Split out of vault.js to keep it under its size cap.

/** @param {any} vault the Vault @param {string} name @param {string} module @param {string} watcher @param {string} agent */
export async function lentToAgent(vault, name, module, watcher, agent) {
  if (module !== "watchers" || !watcher || !agent || !vault.access || typeof vault.access.effectFor !== "function") return false;
  return (await vault.access.effectFor(String(agent), String(name), "vault.read")) === "allow";
}
