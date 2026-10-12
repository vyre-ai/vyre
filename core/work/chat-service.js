// @ts-check
// A team member's own chats on the team's server (0.3.3 J9, the member session door). A member who joined a team reaches its server only through the Space's kernel (kernel/remote), never through a registry
// tool, so their chats are a SERVICE of that remote server (`services.chat`, wire.js CALLS.chat), the way the sidebar and the lent computer are. Every method is `(chain, input)` with the chain the home's own
// Surfaces door minted from what the transport proved: the person is the chain's one person hop and the role is what the Space's kernel says it is, never anything the request names.
//
//   persistent({ kind })   the member's pinned assistant chat (or none yet)     pin({ kind, chat })     make a chat theirs
//   list({ ... })          the chats they may see                              get({ chat })           one chat they are in
//   create({ ... })        start a chat (they are always in it)
//   send, catchup, typing, react, pin-message, reply-mode, mark-read   the stream's own calls in a chat they are in (core/stream `stream.serve`)
//
// Each runs the work module's own chat tool IN THIS SPACE under the member's chain (`work.chat.serve` through registry.callInSpace: the Space's own authorize says whether this member may), so the rules
// and the storage are the tools' own, once. A member never picks the Space, the person or the chain: the service has them from the wire.

import { KernelError } from "../../kernel/core/errors.js";

/** Each call of the wire's `chat` group and the daemon tool that serves it: [tool, the tool's own call]. */
const CALLS = Object.freeze(/** @type {Record<string, [string, string]>} */ ({
  persistent: ["work.chat.serve", "persistent"], pin: ["work.chat.serve", "pin"], list: ["work.chat.serve", "list"], get: ["work.chat.serve", "get"], create: ["work.chat.serve", "create"],
  send: ["stream.serve", "send"], catchup: ["stream.serve", "catchup"], typing: ["stream.serve", "typing"], react: ["stream.serve", "react"], "pin-message": ["stream.serve", "pin"],
  "reply-mode": ["stream.serve", "reply-mode"], "mark-read": ["stream.serve", "mark-read"], read: ["stream.serve", "read"], answer: ["stream.serve", "answer"], stop: ["stream.serve", "stop"],
}));
const CODES = /** @type {Record<string, string>} */ ({ denied: "not_allowed", not_found: "not_found", bad_input: "bad_input", not_declared: "not_found" });

/**
 * @param {{ space: string, kernel: any, registry: { callInSpace(m: any, space: string, base: any, tool: string, input: any, chain: any): Promise<any> } }} o
 */
export function createChatService(o) {
  const who = (/** @type {any} */ chain) => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || chain.viewer === true || chain.delegated === true || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw new KernelError("not_found", "not found");
    return String(h[0].actor.id);
  };
  const isMember = (/** @type {string} */ person) => {
    try { const r = o.kernel?.gateway?.members?.roleOf({ kind: "person", id: person, space: o.space }); return typeof r === "string" && r !== ""; } catch { return false; }
  };
  const run = (/** @type {string} */ name) => async (/** @type {any} */ chain, /** @type {any} */ input) => {
    const person = who(chain);
    if (!isMember(person)) throw new KernelError("not_found", "not found");   // not a member: nothing to say
    const i = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    delete i.space; delete i.as;
    const [tool, call] = CALLS[name];
    const r = await o.registry.callInSpace({ name: "vyred" }, o.space, o.kernel, tool, { call, input: i }, chain);
    if (r && r.error) throw new KernelError(/** @type {any} */ (CODES[r.error.code] || "bad_input"), String(r.error.message || "that did not work"));
    return r.data;
  };
  return Object.fromEntries(Object.keys(CALLS).map(c => [c, run(c)]));
}
