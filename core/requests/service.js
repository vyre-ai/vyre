// @ts-check
// Asking to join, for the Space's remote server (kernel/remote, service `requests`, wire.js CALLS.requests). Two kinds of caller reach it:
//   a person who is NOT a member (the ask door, core/daemon/peer-door.js): ask({ note, entry, name }) and status(). The door puts `entry` (the device key that signed the ask) and `name` (the username the directory
//     confirmed for it) into the arguments itself, over anything the asker sent. The identity is the chain's one person hop, never an argument.
//   a member who is an owner or admin: list, decide, clear (their own role is read from the Space's kernel, never from the request).
// Every method runs the requests module's internal tool requests.serve as the daemon's own door, so the rules and the storage are the module's, once.

import { KernelError } from "../../kernel/core/errors.js";
import { MAY_SET } from "../../kernel/grants/roles.js";

const CODES = /** @type {Record<string, string>} */ ({ denied: "not_allowed", not_found: "not_found", bad_input: "bad_input", limit: "limit" });

/** @param {{ space: string, kernel: any, registry: { call(tool: string, input: any, caller: string, meta?: any): Promise<any> } }} o */
export function createRequestsService(o) {
  const who = (/** @type {any} */ chain) => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || chain.viewer === true || chain.delegated === true || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw new KernelError("not_found", "not found");
    return String(h[0].actor.id);
  };
  const roleOf = (/** @type {string} */ person) => {
    try { const r = o.kernel?.gateway?.members?.roleOf({ kind: "person", id: person, space: o.space }); return typeof r === "string" && r ? r : null; } catch { return null; }
  };
  const serve = async (/** @type {string} */ call, /** @type {string} */ person, /** @type {string | null} */ role, /** @type {any} */ input) => {
    const r = await o.registry.call("requests.serve", { call, person, role, space: o.space, input }, "module:vyred", { door: true });
    if (r && r.error) throw new KernelError(/** @type {any} */ (CODES[r.error.code] || "bad_input"), String(r.error.message || "that did not work"));
    return r.data;
  };
  const obj = (/** @type {any} */ v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  return {
    /** ask({ note, entry, name }): the door supplies entry and name. @param {any} chain @param {any} input */
    async ask(chain, input) {
      const person = who(chain), i = obj(input);
      return serve("ask", person, roleOf(person), { note: i.note, entry: i.entry, ...(i.name ? { name: i.name } : {}) });
    },
    async status(/** @type {any} */ chain) { const person = who(chain); return serve("status", person, roleOf(person), {}); },
    // the admin side: a person who is an owner or admin of this Space; anyone else is told nothing (not found)
    async list(/** @type {any} */ chain) { const person = who(chain), role = roleOf(person); if (role !== "owner" && role !== "admin") throw new KernelError("not_found", "not found"); return serve("list", person, role, {}); },
    /**
     * Answer an ask. Declining is plain. Approving names the invite the approver made: it is read here, from the grants gateway UNDER THE APPROVER'S OWN CHAIN, and must exist, be one this person made, be unused and unexpired, and
     * give a role this person may give; the module then checks it was made for this asker and is not linked to another ask. Anything else is one plain refusal.
     */
    async decide(/** @type {any} */ chain, /** @type {any} */ input) {
      const person = who(chain), role = roleOf(person);
      if (role !== "owner" && role !== "admin") throw new KernelError("not_found", "not found");
      const i = obj(input);
      if (i.approve !== true) return serve("decide", person, role, { id: i.id, approve: false });
      const token = typeof i.invite === "string" ? i.invite : "";
      const invId = token.split(".")[0];
      const plain = new KernelError("bad_input", "Approve by creating the invite first, then name it.");
      if (!/^inv_[0-9a-f]{32}$/.test(invId)) throw plain;
      /** @type {any[]} */ let list;
      try { list = await o.kernel.gateway.grants.invites.list(chain); } catch { throw plain; }
      const inv = (Array.isArray(list) ? list : []).find(x => x && x.id === invId);
      const allowed = /** @type {any} */ (MAY_SET)[/** @type {string} */ (role)] || [];
      if (!inv || inv.issued_by !== person || inv.status !== "pending" || !allowed.includes(inv.role) || typeof inv.invitee !== "string") throw plain;
      return serve("decide", person, role, { id: i.id, approve: true, invite: token, invite_id: invId, invitee: inv.invitee });
    },
    async clear(/** @type {any} */ chain) { const person = who(chain), role = roleOf(person); if (role !== "owner" && role !== "admin") throw new KernelError("not_found", "not found"); return serve("clear", person, role, {}); },
  };
}
