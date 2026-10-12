// @ts-check
// Who is the person of this call? The one answer every tool that scopes to a person asks, so none reads it its own way.
//
// What a call carries (measured, team/0.3.4/MEMBER-SPACE-plan.md "Step 0"): a member's own device, her browser, a visiting person and a tailnet guest reach the registry with NO kernel facts, NO person and
// NO person hop in `ctx.kernel.chain(meta)`; that call answers the calling MODULE's own service chain, which is the module's standing and not hers. The People session (`meta.person`) does not name a person
// either: it is a session id (presence_people has no person column), proof that someone signed in on that device. So the person of a call is, in this order:
//   1. the chain's first person hop, when the kernel can build one (a session token: her assistant or a team chat turn; the owner's enrolled devices); a person, with her id;
//   2. a module or an outside agent's pass acting on its own, with no person: { kind: "module" };
//   3. the owner's own 0600 socket (cli, local, capsule, mcp, harness) with nothing claimed: { kind: "socket" } (the owner's machine; only the owner's Linux user can open it);
//   4. anything else, a remote device or browser with no person hop: NOBODY (null). A tool answers nobody in words (or an empty answer), never "everything".
// A caller that claims a person (a token or facts) whose chain holds no person hop is nobody too: the claim did not prove one.
// Never reads a label's own text for a person id and never reads the input.

/** The labels of the owner's own 0600 socket: exactly these (a thread- or agent-bound label is not one). */
const SOCKET_LABEL = /^(?:cli|local|capsule|mcp|harness)$/;
/** The callers that carry no person by their own kind: a module's own work, and an outside agent holding a pass the owner made. */
const NO_PERSON = /^(?:module|ext):/;

/**
 * @typedef {{ kind: "person", id: string } | { kind: "module" } | { kind: "socket" } | null} PersonOfCall
 */

/**
 * @param {{ kernel?: any } | null | undefined} ctx the module's ctx (its kernel handle builds the chain)
 * @param {any} meta the tool's meta (caller, token, kernelFacts)
 * @returns {Promise<PersonOfCall>}
 */
export async function personOfCall(ctx, meta) {
  const m = meta || {};
  const k = ctx && ctx.kernel;
  /** @type {any} */ let chain = null;
  if (k && typeof k.chain === "function") { try { chain = await k.chain(m); } catch { chain = null; } }
  const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
  const person = hops.find((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person");
  if (person && person.actor.id) return { kind: "person", id: String(person.actor.id) };
  const claims = typeof m.token === "string" || (m.kernelFacts && typeof m.kernelFacts === "object");
  if (claims) return null;
  const caller = String(m.caller || "");
  if (NO_PERSON.test(caller)) return { kind: "module" };
  if (SOCKET_LABEL.test(caller)) return { kind: "socket" };
  return null;
}
