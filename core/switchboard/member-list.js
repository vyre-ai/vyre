// @ts-check
// core/switchboard/member-list.js: threads.list for a Space member: only the threads of that member's own scope, then each one the caller may see. Split out of index.js (its line budget).
import { memberThreadAllowSet, chainPerson, isStaffPerson } from "../../lib/member-scope.js";

/**
 * @param {any} ctx @param {any} rows what the Switchboard listed @param {any} meta the call's meta @param {(meta: any, id: any, write: boolean) => Promise<boolean>} sessionMay
 */
export async function memberListFilter(ctx, rows, meta, sessionMay) {
  if (!Array.isArray(rows)) return rows;
  const allow = await memberThreadAllowSet(ctx, ctx.kernel, meta);
  const scoped = allow ? rows.filter(r => r && allow.has(String(r.id))) : rows;
  const ok = await Promise.all(scoped.map(r => sessionMay(meta, r && r.id, false)));
  return scoped.filter((_, k) => ok[k]);
}

/**
 * Who a new run belongs to: the person the verified chat turn names, else a Space member's own session on the caller's chain (never a caller's word); undefined for the owner and staff.
 * @param {any} ctx @param {any} meta the call's meta @param {{ asker?: string } | null | undefined} kturn
 */
export async function launchPersonOf(ctx, meta, kturn) {
  if (kturn && kturn.asker) return kturn.asker;
  const person = ctx.kernel ? await chainPerson(ctx.kernel, meta) : null;
  const staff = !person || !ctx.kernel || await isStaffPerson(ctx.kernel, person);
  return !staff && person ? person : undefined;
}

/** The person a run records as having started it: the verified chat turn's asker (never a caller's word), else the member's own session token on cli. @param {any} o the launch options */
export const startedBy = o => (o.kernelTurn && o.kernelTurn.asker ? String(o.kernelTurn.asker) : o.person ? String(o.person) : undefined);
