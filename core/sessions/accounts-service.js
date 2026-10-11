// @ts-check
// A team member's own AI sign-in on the team's server (0.3.3 G03). A member who joined a team reaches its server only through the Space's kernel (kernel/remote), never through a registry tool, so their sign-in
// is a SERVICE of that remote server (`services.accounts`, wire.js CALLS.accounts), the way their chats are. Every method is `(chain, input)` with the chain the home's own Surfaces door minted from what the
// transport proved: the person is the chain's one person hop, never anything the request names.
//
//   list({ provider? })               the accounts that are theirs (never the owner's, never another member's)
//   signin({ provider, label? })      start a sign-in the provider runs as a new account of theirs; poll it with { flow }, give it a pasted code with { flow, code }; { account } signs one of theirs in again
//   remove({ id })                    take one of their accounts away
//   default({ id })                   make one of their accounts their pick on its provider
//
// A member does not add an API key here: a key names an item in a Vault, and the server has one Vault, the owner's. A member's key needs a Vault of their own (0.3.4). Each call runs the sessions module's internal
// tool `sessions.accounts.serve`, so the rules and the storage are the module's, once.

import { KernelError } from "../../kernel/core/errors.js";

const CODES = /** @type {Record<string, string>} */ ({ denied: "not_allowed", not_found: "not_found", bad_input: "bad_input", not_asked: "not_allowed" });

/**
 * @param {{ space: string, kernel: any, registry: { call(tool: string, input: any, caller: string, meta?: any): Promise<any> } }} o
 */
export function createAccountsService(o) {
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
    if (!isMember(person)) throw new KernelError("not_found", "not found");   // not a member: nothing to say
    const i = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    delete i.space; delete i.as; delete i.person;
    const r = await o.registry.call("sessions.accounts.serve", { call, person, space: o.space, input: i }, "module:vyred", { door: true });
    if (r && r.error) throw new KernelError(/** @type {any} */ (CODES[r.error.code] || "bad_input"), String(r.error.message || "that did not work"));
    return r.data;
  };
  return { list: run("list"), signin: run("signin"), remove: run("remove"), default: run("default") };
}
