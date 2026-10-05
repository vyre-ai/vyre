// @ts-check
// access: who may read a session's stream (ADR 0052, reviewer gate C-1).
//
// A chat's readers are its participants. An assistant acting for a person reads what that person reads
// and nothing more; an owner or an admin gets no read grant to a chat they are not in. Two kinds of session:
//
//   a thread (a switchboard session)  resolved with threads.get AS THE CALLER (ctx.call with `as`): a
//                                     refusal (denied, not_found) is the answer. This is the 0.2 path.
//   a group chat (a stream session)   its readers are the people in its log's participant-joined frames.
//                                     The caller's person (verified peer, else the named or owner person
//                                     of a local surface; an assistant never names its own) must be one.
//
// With the kernel wired in (ctx.kernel) and the call carrying a session token (ctx.kernel.chain(meta) is then the caller's
// chain, not the module's own), a chat is the kernel's: chats.read(chain, id) decides, so its readers are the chat's
// participants as the kernel holds them (an owner or admin outside the chat, and an assistant acting for someone outside
// it, are refused; a refusal looks like absence). The 0.2 group store is then only a mirror of the kernel's list, and the
// group path below is closed. A session that is not a kernel chat (a switchboard thread) is still read with threads.get.
// Where no kernel is wired (a 0.2 daemon) only the two paths above run. Nothing here creates a log or a
// map entry for an id it refuses.

import { isAgent } from "../../lib/caller.js";

/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {{ ctx: any, groups: any|null, logs: import("./log.js").Logs }} o
 */
export function createAccess({ ctx, groups, logs }) {
  /** The person a call is from. An assistant's claim of `as` is never believed. @param {any} meta @param {any} i */
  const personOf = (meta, i) => (groups ? groups.person(meta, isAgent(meta && meta.caller) ? {} : i) : "person:owner");

  /** The thread, read as the caller. Returns true (it is a thread the caller may read), false (no such thread), or throws the refusal. @param {string} session @param {any} meta */
  async function thread(session, meta) {
    const caller = String((meta && meta.caller) || "");
    let r;
    try { r = await ctx.call("threads.get", { thread: session, limit: 1 }, { as: caller }); }
    catch (e) { throw fail("denied", `${/** @type {Error} */ (e).message}`); }
    if (!r || !r.error) return Boolean(r && r.data);
    const code = String(r.error.code || "");
    if (code === "denied" || code === "forbidden" || code === "person_session_required") throw fail("denied", "you may not read this session");
    return false; // not_found, no_such_tool, not_available: not a thread this box knows
  }

  /** The person a kernel chain is for: its first hop, when that is a person. @param {any} chain */
  const kernelPerson = chain => { const h = chain && Array.isArray(chain.hops) ? chain.hops[0] : null; return h && h.actor && h.actor.kind === "person" ? String(h.actor.id) : ""; };
  /** The role the Space holds for the person behind a chain (kernel members: a person reads their own membership), else none. @param {any} chain @param {string} id */
  const kernelRole = async (chain, id) => {
    const k = ctx.kernel;
    try { const m = k && k.grants && k.grants.members && typeof k.grants.members.get === "function" ? await k.grants.members.get(chain, id) : null; return m && typeof m.role === "string" ? m.role : ""; } catch { return ""; }
  };

  /**
   * The kernel's chat for this call, when it can speak for the caller: null when no kernel or no token (0.2), { chat: null } when the caller is
   * not in a chat by that id (or there is none: the kernel does not say which), else { chat, chain, person }.
   * @param {string} session @param {any} meta
   * @returns {Promise<null | { chat: any, chain: any, person: string }>}
   */
  async function chat(session, meta) {
    const k = ctx.kernel;
    if (!k || !k.chats || typeof k.chats.read !== "function" || typeof k.chain !== "function" || !meta || typeof meta !== "object") return null;
    // The call's own chain: a session token's (an assistant acting for its person) or the person's own, built from the facts the daemon proved about the connection (no token on a Deck call).
    // A call with neither is the module's own service chain, which is no person: null, and the caller is refused as having no session of its own.
    const chain = await k.chain(meta);
    const person = kernelPerson(chain);
    if (!person) return null;
    try { return { chat: await k.chats.read(chain, session), chain, person }; }
    catch (e) { if (/** @type {any} */ (e).code === "not_found") return { chat: null, chain, person }; throw e; }
  }

  return {
    personOf,
    chat,
    /**
     * Throws not_found or denied unless the caller may read the session. Returns the viewer and which path decided.
     * @param {string} session @param {any} meta @param {any} [i]
     * @returns {Promise<{ viewer: { id: string, roles: string[] }, via: "thread"|"group"|"chat", chain: any, chat?: any, person?: string }>}
     */
    async read(session, meta, i = {}) {
      const kc = await chat(session, meta);
      if (kc) {
        const id = `person:${kc.person}`;
        const role = await kernelRole(kc.chain, kc.person);
        const viewer = { id, roles: /** @type {string[]} */ (role ? [role] : []) };
        if (kc.chat) return { viewer, via: "chat", chain: kc.chain, chat: kc.chat, person: id };
        // The kernel is on and this person is not in a chat by that id: there is nothing to read. (A run is reached through its chat; a thread id is no longer a way in.)
        throw fail("not_found", "no such chat");
      }
      const person = personOf(meta, i);
      // 0.2: every person caller on the box's own surfaces is the owner; a tailnet peer holds no role here (it fails closed).
      const viewer = { id: person, roles: /** @type {string[]} */ (person === "person:owner" ? ["owner"] : []) };
      if (await thread(session, meta)) return { viewer, via: "thread", chain: null };
      // The kernel is on and this call carries no session of its own: the 0.2 group store is not a chat's authority any more.
      if (!(ctx.kernel && ctx.kernel.chats) && groups && groups.known(session)) {
        if (groups.people(session).has(person)) return { viewer, via: "group", chain: null };
        throw fail("not_found", "no such session");
      }
      throw fail("not_found", "no such session");
    },
  };
}
