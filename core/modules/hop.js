// @ts-check
// core/modules/hop.js: when a module's own call carries a person through to the next tool (the "hop"): the gate then judges the call as that person (`meta.origin`) and not as the module.
//
// The principle. A hop never makes anyone more than they were. Origin is the caller class of the call the module is serving, so an agent or a model session going through a module is still judged
// as that agent or model. What the hop decides is only whether a module may act for a person at all:
//   - a tool the registry defaulted to person-only (a write with no declared reach): any module acting for a person may reach it;
//   - a tool that EXPLICITLY declares reach "person" (the vault, google.open, gate.said.add ...): a module reaches it only when the call itself proves the person (a relayed call, the person's
//     own session) or the host that runs it is the person's own act (a Flow step the Flows host runs, a view click the person made, a call inside a space's own chain).
// An explicit person-only tool is never reached by a module's plain ctx.call, even for the person: the module could be called by anything. hop.test.js holds this table.
import { isPerson } from "../../lib/caller.js";
import { modelCaller } from "./needs-you-hold.js";

/** Set only by Registry.callFlow, after the Flows host has spent the task approval a person gave for exactly this act: the call then counts as the person's own yes, as a redeemed card does. A symbol key cannot come over the wire. */
export const FLOW_ACT = Symbol("vyre.flow_act");
/** Set only by Registry.callFlow on every step it runs: the Flow's person acting through the Flows host. A symbol key cannot come over the wire. */
export const FLOW_RUN = Symbol("vyre.flow_run");
/** The ways a module's call is the person's own act. @typedef {{ relayed: boolean, spaceHop: boolean, flowRun: boolean, viewFor: boolean }} Proof */

/**
 * @param {{ defaulted: boolean, reach?: string }} def the tool
 * @param {{ firstParty: boolean, origin?: unknown } & Proof} call the module's call
 */
export function mayHop(def, call) {
  if (def.defaulted) return true;
  const proven = call.relayed || call.spaceHop || call.flowRun || call.viewFor;
  return Boolean(call.firstParty && def.reach === "person" && call.origin && proven);
}

/**
 * The call's caller is a person's own surface and not a model. Onboard and identity relay from it before a session token exists; every other module needs proven facts or a token.
 * @param {unknown} caller
 */
export function onPersonSurface(caller) { return isPerson(String(caller)) && !modelCaller(String(caller)); }

/**
 * ctx.events.origin and ctx.events.withOrigin for one module. A module may replay an origin it was handed (it keeps ctx.events.origin() beside work it stores for later), but only Vyre's own modules may
 * name any caller class: an added module that could would have the gate judge its call as the person's own surface.
 * @param {() => boolean} firstParty @param {() => string | undefined} capture @param {(o: string | undefined, f: () => any) => any} run
 */
export function originApi(firstParty, capture, run) {
  const handed = new Set();
  return {
    origin: () => { const o = capture(); if (o && handed.size < 1000) handed.add(o); return o; },
    withOrigin: (/** @type {string | undefined} */ o, /** @type {() => any} */ f) => {
      if (o && !firstParty() && !handed.has(o)) throw Object.assign(new Error(`withOrigin: this module was never handed the origin ${o}`), { code: "denied" });
      return run(o, f);
    },
  };
}
