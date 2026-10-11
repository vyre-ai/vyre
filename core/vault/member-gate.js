// @ts-check
// core/vault/member-gate.js: the vault is the Space owner's. One place, before any vault tool runs: a call whose kernel chain has a person who is not the Space's owner (a member directly, or the person
// behind that member's assistant or a named agent of theirs) is refused, whatever the tool and whatever presence says. A module's call, an outside agent's pass call and a call that claims no person at all (the owner's terminal, the daemon itself) are unchanged; a call that claims a person (a session token or the daemon's connection facts) must show a readable chain whose every person hop is the owner, or it is refused. The owner is read from the kernel, never from the input.
//
// Fail closed: every tool the vault registers goes through here (ctx.tool is wrapped for the whole module), a tool added later is refused for members unless its name is added to MEMBER_ALLOWED, and a
// test lists every registered vault tool and fails for one that is not wrapped.

/**
 * The vault tool names a non-owner person may call. Empty: a member reaches nothing of the owner's vault. A name is added here deliberately, one at a time (a member's own key tools do that when they land).
 * @type {Set<string>}
 */
export const MEMBER_ALLOWED = new Set([]);

/** The names of the tools that were registered through the gate (so a test can tell one that slipped past). */
export const GATED = new Set();

export const MEMBER_REFUSAL = "this is the owner's vault: ask the owner to share the item with you, or add your own key in your account settings";

/** Every person hop of a call's chain, from the kernel. Throws when the chain cannot be read. @param {any} k @param {any} meta @returns {Promise<string[]>} */
async function personsOf(k, meta) {
  const c = await k.chain(meta || {});
  return (c && Array.isArray(c.hops) ? c.hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id));
}

/** The callers that provably have no person behind them, by the registry's own caller kind: a module's call, and an outside agent holding a pass the owner made (vault.mcp.*). */
const NO_PERSON = (/** @type {string} */ caller) => caller.startsWith("module:") || /^ext:/.test(caller);

/**
 * The module's ctx with every tool wrapped by the owner check. The wrapped run is named in GATED, so a test can tell a gated tool from one that slipped past.
 * @param {any} ctx
 */
export function gateTools(ctx) {
  const check = async (/** @type {string} */ name, /** @type {any} */ meta) => {
    if (MEMBER_ALLOWED.has(name)) return;
    const k = ctx.kernel;
    if (!k || typeof k.chain !== "function") return;   // a home with no kernel has no members to keep out
    const caller = String((meta && meta.caller) || "");
    if (NO_PERSON(caller)) return;
    // A call CLAIMS a person when it carries a session token or the daemon's proven facts about a person's connection. Every member reaches the server that way (the member door, a peer session, a paired
    // device, their assistant's session): there is no member path without one. A call that claims none is not made for anyone: the owner's own terminal over the 0600 unix socket (the same convention as
    // core/spaces/kernel-members.js, where a person-surface call with no token and no facts is the owner's), or the daemon itself. Those are unchanged.
    const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
    if (!claims) return;
    // A claimed person must be proven, and be the owner at every hop: a chain that cannot be read, or whose facts did not hold (a service chain with no person), is refused.
    const refuse = () => Object.assign(new Error(MEMBER_REFUSAL), { code: "denied" });
    let persons;
    try { persons = await personsOf(k, meta); } catch { throw refuse(); }
    if (!persons.length || !k.owner || persons.some(p => p !== String(k.owner))) throw refuse();
  };
  const tool = (/** @type {string} */ name, /** @type {any} */ def) => {
    const run = def && def.run;
    if (typeof run !== "function") return ctx.tool(name, def);
    GATED.add(name);
    const gated = async (/** @type {any} */ i, /** @type {any} */ meta, /** @type {any[]} */ ...rest) => { await check(name, meta); return run(i, meta, ...rest); };
    return ctx.tool(name, { ...def, run: gated });
  };
  return new Proxy(ctx, { get: (t, p) => (p === "tool" ? tool : Reflect.get(t, p, t)) });
}
