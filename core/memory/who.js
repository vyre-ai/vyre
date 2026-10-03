// @ts-check
// Who is calling memory, as the KERNEL says it (CUTOVER section H). One `Who` is built per call from the call's kernel chain (kernel-gate.js) and read by the access
// predicates in index.js, write.js and site.js in place of caller label strings: the person's own surface, their other device (and whether they signed in on it), their own
// session, an agent's name. With the kernel off there is no `Who` and those predicates read the label exactly as before (SHIM(legacy labels): deleted with the kernel-off path
// at cut-over). Nothing here is client-supplied: the chain comes from the daemon's proven facts or a session token, and the module flag from the registry.
import { AsyncLocalStorage } from "node:async_hooks";
import { PERSON_SURFACES } from "../presence/index.js";

/** The person's own surfaces on this machine. `mobile` is not one (it never was), and is not special-cased here. */
export const OWNER_SURFACES = PERSON_SURFACES;

/**
 * @typedef {{ ownerSurface: boolean, device: boolean, nodeDevice: boolean, signedIn: boolean, ownSession: boolean, agent: string|null, module: { name: string, firstParty: boolean }|null, capsule?: boolean }} Who
 * ownerSurface: the person (the home's owner) at cli, local, deck or the Capsule. device: the owner on another paired or signed-in device; nodeDevice: one that arrived over the Wink node
 * path (what `tailnet:<login>` was), which reads memory as the owner does; a device over the relay (`device:<id>`) never did, and does not now. signedIn: their passkey session on it.
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
  const first = hops[0], via = first.via || {};
  const agent = hops.slice(1).find((/** @type {any} */ h) => h.actor.kind === "agent");
  const entered = first.entered_by;
  const sf = surface && surface.hops && surface.hops[0] ? surface.hops[0] : (entered === "surface" ? first : null);
  const sv = sf ? sf.via || {} : {};
  const onSurface = Boolean(sf) && sf.entered_by === "surface";
  return {
    ownerSurface: onSurface && !sv.device && OWNER_SURFACES.has(String(sv.surface)),
    device: onSurface && Boolean(sv.device),
    nodeDevice: onSurface && Boolean(sv.device) && Boolean(sv.node),
    signedIn: onSurface && Boolean(sv.device) && Boolean(sv.session),
    ownSession: entered === "session" && hops.length === 1,
    agent: agent ? String(agent.actor.id) : null,
    module: null,
  };
}

/** A first-party module's own call: not a person, not an agent. @param {string} caller @returns {Who} */
export const whoOfModule = caller => ({ ownerSurface: false, device: false, nodeDevice: false, signedIn: false, ownSession: false, agent: null, module: { name: String(caller).slice(7), firstParty: true } });
/** The Capsule, the named exception until platform wires its signature check into the daemon's facts: the owner's own surface. @returns {Who} */
export const whoOfCapsule = () => ({ ownerSurface: true, device: false, nodeDevice: false, signedIn: false, ownSession: false, agent: null, module: null, capsule: true });
