// @ts-check
// kernel/flows/standing-run: the runner's side of the standing approval. For one send step of a turned-on Flow it decides whether the person's yes at turn-on covers THIS send (the step does not always ask,
// every recipient is on the Flow's allow list, and a recipient that comes from outside content is only let through when the Flow says so), and if so asks the host for the receipt. The host answers
// from the kernel's own grant for the Flow version the run is on (core/daemon/flows-host.js), never from anything the runner or a step claims.

import { RECIPIENT_FIELDS, allowed, boundsOf, isSend, recipientOf } from "./standing.js";

const strings = (/** @type {any} */ v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter(x => typeof x === "string") : []);

/**
 * @param {{ ports: any, chain: any, ctx: any, s: any, need: { action: string, resource: string }, info: { input?: any }, risk: string, cat: any }} a
 * @returns {Promise<string | null>} the receipt, or null when this send asks as before
 */
export async function standingFor({ ports, chain, ctx, s, need, info, cat }) {
  if (typeof ports.standing !== "function" || s.approve === true || s.kind !== "call" || !isSend(s, cat)) return null;
  const b = boundsOf(ctx.flow, cat);
  const literal = recipientOf(s).literal;
  if (!literal && b.outside === "ask") return null;
  const actual = RECIPIENT_FIELDS.flatMap(f => (info.input && info.input[f] !== undefined ? strings(info.input[f]) : []));
  if (actual.some(r => !allowed(r, b.allow))) return null;
  const r = await ports.standing({ chain, flow: ctx.run.flow, version: ctx.run.version, run: ctx.run.id, step: s.id, action: need.action, resource: need.resource, recipients: actual, bounds: b });
  return r && typeof r.receipt === "string" ? r.receipt : null;
}
