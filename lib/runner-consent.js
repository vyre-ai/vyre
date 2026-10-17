// @ts-check
// One gate for every path that places or runs a member's own session on their own computer: kernel Offers (space_allows + member_accepts per device key) and spaces.compute (terms hash, maxSessions). Used by the lent home (every OS shares the same book), the lender runner, move/resume/adopt, spawn, and the switchboard.

import { COMPUTE_TERMS_DEFAULT } from "./spaces/compute.js";

/** @param {{ spaceAllows?: boolean, memberAccepts?: boolean } | null | undefined} a */
export function offersGrant(a) {
  return Boolean(a && a.spaceAllows && a.memberAccepts);
}

/** @param {{ active(q: any): { spaceAllows: boolean, memberAccepts: boolean } }} offers @param {string} member @param {string} device @param {string} [device_key] */
export function activeOffers(offers, member, device, device_key) {
  return offers.active({ member, device, ...(device_key ? { device_key } : {}) });
}

export function standsOffers(offers, member, device, device_key) {
  return offersGrant(activeOffers(offers, member, device, device_key));
}

/** Sessions the book says run on this device now (mac), for maxSessions. @param {any[]} rows @param {string} person @param {string} device @param {string} [exceptSession] */
export function countMacSessions(rows, person, device, exceptSession) {
  let n = 0;
  for (const r of rows) {
    if (!r || r.where !== "mac" || r.person !== person || r.device !== device) continue;
    if (exceptSession && String(r.session) === String(exceptSession)) continue;
    n++;
  }
  return n;
}

/**
 * @param {{ mayRun(a: any): Promise<any> } | null | undefined} compute
 * @param {{ person: string, device?: string, exceptSession?: string, rows?: any[] }} q
 */
export async function computeGrant(compute, q) {
  if (!compute || typeof compute.mayRun !== "function") return { allow: true, terms: COMPUTE_TERMS_DEFAULT };
  const running = countMacSessions(q.rows || [], q.person, q.device || "", q.exceptSession);
  return compute.mayRun({ actor: q.person, session: { owner: q.person, running }, machine: { owner: q.person } });
}

/**
 * Full consent for placing or starting on a computer (Offers + compute terms/limit).
 * @param {{ offers: any, compute?: any, person: string, device: string, device_key?: string, rows?: any[], exceptSession?: string }} q
 */
export async function memberMayRunOnComputer(q) {
  if (!standsOffers(q.offers, q.person, q.device, q.device_key)) {
    const a = activeOffers(q.offers, q.person, q.device, q.device_key);
    if (!a.spaceAllows) return { allow: false, code: "space", message: "this space has not allowed members to run its work on their own computers" };
    return { allow: false, code: "member", message: "this computer is not allowed to run this Space's work" };
  }
  const c = await computeGrant(q.compute, { person: q.person, device: q.device, exceptSession: q.exceptSession, rows: q.rows });
  if (!c.allow) return { allow: false, code: String(c.reason || "compute"), message: String(c.message || "this computer may not run this space's work now") };
  return { allow: true, terms: c.terms || COMPUTE_TERMS_DEFAULT };
}
