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
async function ids(k, meta) {
  const c = await k.chain(meta || {});
  return (c && Array.isArray(c.hops) ? c.hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id));
}

/** The labels the owner's own 0600 unix socket carries when the daemon could measure nothing more (core/daemon/index.js callerFacts; a socket only the owner's Linux user can open). */
const SOCKET_LABELS = new Set(["cli", "local", "capsule", "mcp", "harness"]);

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
    // A call CLAIMS a person when it carries a session token, the daemon's proven facts about a person's connection, or a People session (meta.person). Every member reaches the server that way (their
    // app's session, a paired device's peer stream, their assistant's or agent's thread socket, which stamps the session's token on every call and refuses the call when it has none): there is no member
    // path without one, and a claim that does not prove to be the owner is refused below. A module hop inherits the running turn's token (core/modules/index.js runInTurn), so a module's call made for a
    // member carries the member's claim and is refused like the member's own; a module's call with no claim (its own work) passes.
    const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object") || meta.person));
    if (!claims) {
      // Unclaimed: only the labels of the owner's own 0600 unix socket (their terminal, the Capsule, their local Claude's plain MCP), or a call the daemon makes in-process. Every other unclaimed caller is
      // refused by its own marker: a device or a browser session whose connection gave no facts (a member's device is given none), a thread- or agent-bound model label (the thread socket always stamps
      // a token), a tailnet node, a guest, a deck or mobile label that no listener vouched for.
      if (NO_PERSON(caller) || SOCKET_LABELS.has(caller)) return;
      throw Object.assign(new Error(MEMBER_REFUSAL), { code: "denied" });
    }
    // A claimed person must be proven, and be the owner at every hop: a chain that cannot be read, or whose facts did not hold (a service chain with no person), is refused.
    const refuse = () => Object.assign(new Error(MEMBER_REFUSAL), { code: "denied" });
    let persons;
    try { persons = await ids(k, meta); } catch { throw refuse(); }
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
