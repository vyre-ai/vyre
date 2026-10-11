// @ts-check
// core/vault/member-gate.js: the vault is the Space owner's. One place, before any vault tool runs: a call made for a person who is not the Space's owner (a member directly, or the person behind that
// member's assistant or a named agent of theirs) is refused, whatever the tool and whatever presence says. The owner is read from the kernel, never from the input.
//
// THE RULE (team lead's, final):
//  1. Nobody to keep out: when the Space's kernel has no member but the owner (asked of the kernel on every call, nothing cached; every non-owner person with any role counts, and doubt or an error answers "others exist"), the gate passes. A single-person install is untouched.
//  2. A CLAIM is a session token or the daemon's proven kernelFacts. A claim must prove: the chain readable, at least one person hop, every person hop the owner. Otherwise refused.
//     (The unclaimed pass for those labels rests on the main socket being reachable only by the daemon's own Linux user: chmod 0600, core/daemon/index.js. A session under another user cannot open it.)
//  3. A call that claims nothing passes only for the owner's local socket labels (cli, local, capsule, mcp, harness: a socket only the owner's Linux user can open) and for module:/ext: callers. Every other
//     unclaimed caller (device:*, web:*, setup:*, tailnet*, space:*, deck, mobile, mcp:thread:*, mcp:agent:*, harness:thread:*, harness:agent:*, cli:agent:*) is refused.
//  4. A People session (meta.person) is NOT proof of the owner: it proves a device signed in, and a member enrols a device of their own. The owner's own remote surfaces get in by positive proof: callerFacts
//     (core/daemon/index.js) builds kernelFacts for a device whose row names the owner, and that claim proves. A module hop inherits the running turn's token (core/modules/index.js runInTurn), so a module's
//     call made for a member carries the member's claim and is refused like the member's own; a module's call with no claim (its own work) passes.
//     On a one-person server this gate is not the only barrier for remote callers who are not members: the registry's per-tool `callers` lists still refuse them.
//     KNOWN OPEN (rc.2): on a server whose owner has not yet claimed an identity, a member's paired device is treated as the owner's (callerFacts, core/daemon/index.js). The product path makes the owner choose a name
//     before a team Space or an invite exists; the kernel does not enforce it. Fix planned for rc.2.
//  5. Fail closed: every tool the vault registers goes through here (ctx.tool is wrapped for the whole module); a tool added later is refused for members unless its name is in MEMBER_ALLOWED; and a
//     kernel that was there when the module started and is gone at a call refuses (only a home that ran no kernel at start is left open: it has no members). A test lists every registered vault tool.

/**
 * The vault tool names a non-owner person may call. Empty: a member reaches nothing of the owner's vault. A name is added here deliberately, one at a time (a member's own key tools do that when they land).
 * @type {Set<string>}
 */
export const MEMBER_ALLOWED = new Set([]);

/** The names of the tools that were registered through the gate (so a test can tell one that slipped past). */
export const GATED = new Set();

/** What the last gateTools() saw of the kernel at the module's start (a test reads it on a kernel-on daemon: a boot-order slip would leave a team server open). */
export const STARTED = { withKernel: /** @type {boolean | null} */ (null) };

export const MEMBER_REFUSAL = "this is the owner's vault: ask the owner to share the item with you, or add your own key in your account settings";

/** The labels of the owner's own 0600 unix socket (core/daemon/index.js: a socket only the owner's Linux user can open), exactly: a thread- or agent-bound label is not one of them. */
const SOCKET_LABEL = /^(?:cli|local|capsule|mcp|harness)$/;

/** Every person hop of a call's chain, from the kernel. Throws when the chain cannot be read. @param {any} k @param {any} meta @returns {Promise<string[]>} */
async function ids(k, meta) {
  const c = await k.chain(meta || {});
  return (c && Array.isArray(c.hops) ? c.hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id));
}

/** The callers that carry no person by their own kind: a module's call, and an outside agent holding a pass the owner made (vault.mcp.*). */
const NO_PERSON = (/** @type {string} */ caller) => caller.startsWith("module:") || /^ext:/.test(caller);

/**
 * The module's ctx with every tool wrapped by the owner check.
 * @param {any} ctx
 */
export function gateTools(ctx) {
  // A daemon fact, fixed when the module starts: the kernel is wired before any module starts (core/daemon/index.js sets registry.deps.kernelFor, then starts the registry). A home that ran no kernel then has
  // no members; one that did and loses its handle later refuses, it does not open.
  const kernelRuns = Boolean(ctx.kernel);
  STARTED.withKernel = kernelRuns;
  const refuse = () => Object.assign(new Error(MEMBER_REFUSAL), { code: "denied" });
  const check = async (/** @type {string} */ name, /** @type {any} */ meta) => {
    if (MEMBER_ALLOWED.has(name)) return;
    const k = ctx.kernel;
    if (!k || typeof k.chain !== "function") { if (kernelRuns) throw refuse(); return; }
    // 1. nobody to keep out: asked every call, never remembered across a join. Unknown (the handle cannot say, or it throws) means there may be someone, so the rule applies.
    if (typeof k.hasOtherMembers === "function") {
      let others = true;
      try { others = (await k.hasOtherMembers()) === true; } catch { others = true; }
      if (!others) return;
    }
    const caller = String((meta && meta.caller) || "");
    const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
    if (!claims) {
      if (NO_PERSON(caller) || SOCKET_LABEL.test(caller)) return;
      throw refuse();
    }
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
