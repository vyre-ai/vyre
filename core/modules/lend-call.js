// @ts-check
// lend-call: the Switchboard's one way to a member's own AI key (needs.daemon "lendKey", core/daemon/lend-key.js): vault.me.lend and nothing else, as module:threads, on `token`, a one-turn session of that one person
// which the daemon opened and ends. Nothing a tool or a client sends can reach this: only the daemon holds the registry it is given.

/** @param {{ call: (tool: string, input: any, caller: string, meta: any) => Promise<any> }} registry @param {{ account: string }} input @param {{ token: string }} o */
export async function callLend(registry, input, o) {
  if (!o || typeof o.token !== "string" || !o.token) return { error: { code: "denied", message: "a member's key is lent on that member's own session" } };
  return registry.call("vault.me.lend", { account: String(input && input.account || "") }, "module:threads", { origin: "deck", token: o.token });
}
