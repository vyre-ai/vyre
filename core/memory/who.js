// @ts-check
// Who is calling memory, as the KERNEL says it (CUTOVER section H). One `Who` is built per call from the call's kernel chain (kernel-gate.js) and read by the access
// predicates in index.js, write.js and site.js in place of caller label strings: the person's own surface, their other device (and whether they signed in on it), their own
// session, an agent's name. A call with no `Who` (no kernel, or no chain) is nobody: every predicate says no. Nothing here is client-supplied: the chain comes from the daemon's proven facts or a session token, and the module flag from the registry.
import { AsyncLocalStorage } from "node:async_hooks";
import { PERSON_SURFACES } from "../presence/index.js";

/** The person's own surfaces on this machine. `mobile` is not one (it never was), and is not special-cased here. */
export const OWNER_SURFACES = PERSON_SURFACES;

/**
 * @typedef {{ ownerSurface: boolean, device: boolean, nodeDevice: boolean, signedIn: boolean, ownSession: boolean, agent: string|null, acting: { kind: string, id: string }|null, conflict?: boolean, module: { name: string, firstParty: boolean }|null, capsule?: boolean }} Who
 * ownerSurface: the person (the home's owner) at cli, local, deck or the Capsule. device: the owner on another paired or signed-in device; nodeDevice: one that arrived over the Wink node
 * path (what `tailnet:<login>` was). signedIn: their passkey session on it. RULING (6 Oct): an owner's own device reads memory as the owner only when signed in, over Wink or the relay
 * alike (`nodeDevice` is kept as a fact, but no longer decides); an unsigned device, a device that is not the owner's and any agent hop read nothing personal.
 * ownSession: the person's own Claude Code session or Vyre thread (a session token, no agent beside them). agent: the agent hop's name. module: a module's own call.
 */

/** @type {AsyncLocalStorage<Who>} */
export const whoStore = new AsyncLocalStorage();
/** The running call's Who, or undefined when the kernel is off (the label decides, as before). */
export const current = () => whoStore.getStore();

/**
 * From a kernel chain whose first hop is already known to be the home's owner. A session token's chain says nothing about the SURFACE it was opened from (it wins over the
 * daemon's proven facts in `ctx.kernel.chain`), so when the daemon also proved a surface for this connection (`surface`: the chain the kernel built from those facts alone),
 * the surface, device and sign-in come from it, and the session and the agent from the token's chain: a Deck chat is the person at their Deck AND their own session.
 * @param {any} chain @param {any} [surface] @returns {Who}
 */
export function whoOfChain(chain, surface = null) {
  const hops = chain.hops;
  const first = hops[0];
  const after = hops.slice(1);
  // MA-6: ANY hop after the person that is not another person (an agent, a Flow's automation, a module's service) means this is not the person acting: never an owner surface,
  // device or signed-in device, whatever facts ride beside the chain.
  const notPerson = after.some((/** @type {any} */ h) => h.actor.kind !== "person");
  // MA-7: the NARROWEST agent wins: any named agent beats the assistant (the assistant's reach is the wider one), so `[person, assistant, kit]` and `[person, kit, assistant]` both read as kit.
  const names = after.filter((/** @type {any} */ h) => h.actor.kind === "agent").map((/** @type {any} */ h) => String(h.actor.id));
  const named = [...new Set(names.filter((/** @type {string} */ n) => n !== "assistant"))];
  const agent = named[0] ?? (names.length ? "assistant" : null);
  // Two different named agents in one chain: which one is calling is not knowable, so the call is refused (the gate reads `conflict`).
  const conflict = named.length > 1;
  const actingHop = after.find((/** @type {any} */ h) => h.actor.kind === "automation" || h.actor.kind === "service");
  const acting = actingHop ? { kind: String(actingHop.actor.kind), id: String(actingHop.actor.id) } : null;
  const sf = !notPerson && surface && surface.hops && surface.hops[0] ? surface.hops[0] : (!notPerson && first.entered_by === "surface" ? first : null);
  const sv = sf ? sf.via || {} : {};
  const onSurface = Boolean(sf) && sf.entered_by === "surface";
  // The person's own session: a session token with nobody beside them, or exactly the assistant (the person's own Claude, which the kernel's token chain shows as
  // [person, agent:assistant]; no chain fact tells a thread from a named agent, so `assistant` is the one name that stands for it). Never read off a label.
  const tokenSession = first.entered_by === "session" && (hops.length === 1 || (hops.length === 2 && agent === "assistant"));
  return {
    ownerSurface: onSurface && !sv.device && OWNER_SURFACES.has(String(sv.surface)),
    device: onSurface && Boolean(sv.device),
    nodeDevice: onSurface && Boolean(sv.device) && Boolean(sv.node),
    signedIn: onSurface && Boolean(sv.device) && Boolean(sv.session),
    ownSession: tokenSession,
    agent,
    acting,
    conflict,
    module: null,
  };
}

/** A first-party module's own call: not a person, not an agent. @param {string} caller @returns {Who} */
export const whoOfModule = caller => ({ ownerSurface: false, device: false, nodeDevice: false, signedIn: false, ownSession: false, agent: null, acting: null, module: { name: String(caller).slice(7), firstParty: true } });
