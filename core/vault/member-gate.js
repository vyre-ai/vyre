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

/** The caller classes a listener creates for a connection that is not on the owner's own socket (core/modules/index.js callerKind classes web and setup; device: from the relay and peer door; tailnet nodes; another Space's peer). */
const REMOTE = /^(?:device:|web:|setup:|space:|tailnet)/;

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
    // A call CLAIMS a person when it carries a session token or the daemon's proven facts about a person's connection. Every member reaches the server that way (their assistant's or agent's thread socket
    // stamps the session's token on every call and refuses the call when it has none; a member's paired device is denied at the peer door before the registry when it has no facts: core/daemon/peer-door.js),
    // and a claim that does not prove to be the owner at every hop is refused below. A module hop inherits the running turn's token (core/modules/index.js runInTurn), so a module call made for a member
    // carries the member's claim and is refused like the member's own; a module's call with no claim (its own work) passes.
    const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
    if (!claims) {
      if (NO_PERSON(caller)) return;
      // A REMOTE caller (a device, a browser, a setup page, a tailnet node, another Space's peer) that claims no person must show a People session, the daemon's own sign-in of a device the OWNER paired
      // (presence_people has no person column: its sessions are the owner's devices). A remote caller with neither is refused: nothing shows who it is.
      if (REMOTE.test(caller)) {
        if (meta && meta.person) return;
        throw Object.assign(new Error(MEMBER_REFUSAL), { code: "denied" });
      }
      // Every other unclaimed label reaches vyred only on the owner's own 0600 unix socket or through the owner's own listeners (their terminal, the Capsule, deck and mobile as the owner's listeners set
      // them, their local Claude and a thread or agent label on that socket): a member's session never arrives unclaimed (it carries its token), so there is no one else to keep out here.
      return;
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
