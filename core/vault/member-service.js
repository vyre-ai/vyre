// @ts-check
// A team member's own Vault on the team's server, for the one thing the first run needs: putting an AI key of theirs in it (0.7). A member reaches the server only through the Space's kernel (kernel/remote), so these are
// a SERVICE of that remote server (`services.myvault`, wire.js CALLS.myvault), the way their AI sign-in is (core/sessions/accounts-service.js). Every method is `(chain, input)` with the chain the home's own
// Surfaces door minted from what the transport proved: the person is the chain's one person hop, never anything the request names. Each call runs the vault's internal tool vault.me.serve, which runs the SAME functions as the
// vault.me.* tools, so the rules live once. Nothing here logs or returns the password, the Secret Key or a value.
//
//   status()                               { account, unlocked, acct? }
//   create({ password })                   make their vault: the Secret Key comes back once, to their device
//   unlock({ password, secretKey })        open it (the device holds the Secret Key)
//   list()                                 the names and kinds of their items, never a value
//   put({ name, kind: "api-key", fields: { value } })   one AI key

import { KernelError } from "../../kernel/core/errors.js";

const CODES = /** @type {Record<string, string>} */ ({ denied: "not_allowed", not_found: "not_found", bad_input: "bad_input", locked: "locked" });

/** @param {{ space: string, kernel: any, registry: { call(tool: string, input: any, caller: string, meta?: any): Promise<any> } }} o */
export function createMemberVaultService(o) {
  const who = (/** @type {any} */ chain) => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || chain.viewer === true || chain.delegated === true || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw new KernelError("not_found", "not found");
    return String(h[0].actor.id);
  };
  const isMember = (/** @type {string} */ person) => {
    try { const r = o.kernel?.gateway?.members?.roleOf({ kind: "person", id: person, space: o.space }); return typeof r === "string" && r !== ""; } catch { return false; }
  };
  const run = (/** @type {string} */ call) => async (/** @type {any} */ chain, /** @type {any} */ input) => {
    const person = who(chain);
    if (!isMember(person)) throw new KernelError("not_found", "not found");
    const i = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    delete i.space; delete i.as; delete i.person;
    const r = await o.registry.call("vault.me.serve", { call, person, space: o.space, input: i }, "module:vyred", { door: true });
    if (r && r.error) throw new KernelError(/** @type {any} */ (CODES[r.error.code] || "bad_input"), String(r.error.message || "that did not work"));
    return r.data;
  };
  return { status: run("status"), create: run("create"), unlock: run("unlock"), list: run("list"), put: run("put") };
}
