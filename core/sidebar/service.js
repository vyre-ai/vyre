// @ts-check
// The sidebar for a team's members (SPEC-0.3.0 part 9). A member who joined a team reaches the team's server only through its Space's kernel (kernel/remote), never through a registry tool, so the
// sidebar is a SERVICE of that remote server (`services.sidebar`, wire.js CALLS.sidebar), the way the lent computer is. Every method is `(chain, input)` with the chain the home's own Surfaces door
// minted from what the transport proved: the person is the chain's one person hop and the role is what the Space's kernel says it is, never anything the request names.
//
//   get({ space? })    the Space's default with this member's own list on top
//   edit({ op, ... })  one change to this member's OWN list
//   team({ op, ... })  one change to the Space's default: only the Space's owner or admin role
//
// Each runs the sidebar module's internal tool `sidebar.serve` with that person and role, so the rules and the storage are the module's, once.

import { KernelError } from "../../kernel/core/errors.js";

const CODES = { denied: "not_allowed", not_found: "not_found", bad_input: "bad_input" };

/**
 * @param {{ space: string, kernel: any, registry: { call(tool: string, input: any, caller: string, meta?: any): Promise<any> } }} o
 */
export function createSidebarService(o) {
  const who = (/** @type {any} */ chain) => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw new KernelError("not_found", "not found");
    return String(h[0].actor.id);
  };
  const roleOf = (/** @type {string} */ person) => {
    try {
      const m = o.kernel?.gateway?.members?.roleOf({ kind: "person", id: person, space: o.space });
      return typeof m === "string" ? m : null;
    } catch { return null; }
  };
  const run = (/** @type {"get" | "edit" | "team"} */ call) => async (/** @type {any} */ chain, /** @type {any} */ input) => {
    const person = who(chain), role = roleOf(person);
    if (!role) throw new KernelError("not_found", "not found");   // not a member: nothing to say
    const i = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    delete i.as;
    const r = await o.registry.call("sidebar.serve", { call, person, role, space: o.space, input: { ...i, space: o.space } }, "module:vyred", { door: true });
    if (r && r.error) throw new KernelError(/** @type {any} */ (CODES)[r.error.code] || "bad_input", String(r.error.message || "that did not work"));
    return r.data;
  };
  return { get: run("get"), edit: run("edit"), team: run("team") };
}
