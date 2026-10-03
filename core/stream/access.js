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
// With the kernel wired in and the call carrying a session token (ctx.kernel.chain(meta) is then the
// caller's chain, not the module's own), the kernel's authorize is asked too, for action session.read on
// vyre://<space>/session/<id>; an `unknown_action` answer (the action is not registered in this Space yet)
// does not decide, the participant rule above always does. A deny from the kernel always refuses.
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

  /** The kernel's say, when it can speak for the caller. @param {string} session @param {any} meta */
  async function kernel(session, meta) {
    const k = ctx.kernel;
    if (!k || typeof k.authorize !== "function" || typeof k.chain !== "function" || !meta || typeof meta.token !== "string") return "none";
    const chain = await k.chain(meta);
    const r = await k.authorize({ chain, action: "session.read", resource: `vyre://${k.space}/session/${session}` });
    if (r && r.effect === "allow") return "allow";
    if (r && r.reason === "unknown_action") return "none";
    return "deny";
  }

  return {
    personOf,
    /**
     * Throws not_found or denied unless the caller may read the session. Returns the viewer and which path decided.
     * @param {string} session @param {any} meta @param {any} [i]
     * @returns {Promise<{ viewer: { id: string, roles: string[] }, via: "thread"|"group" }>}
     */
    async read(session, meta, i = {}) {
      const person = personOf(meta, i);
      if ((await kernel(session, meta)) === "deny") throw fail("denied", "you may not read this session");
      const viewer = { id: person, roles: /** @type {string[]} */ ([]) };
      if (await thread(session, meta)) return { viewer, via: "thread" };
      if (groups && groups.known(session)) {
        if (groups.people(session).has(person)) return { viewer, via: "group" };
        throw fail("not_found", "no such session");
      }
      throw fail("not_found", "no such session");
    },
  };
}
