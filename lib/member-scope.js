// @ts-check
// One place for "is this kernel session the home owner/admin (owner-wide reads) or a member (scoped reads)?"
// Modules must not treat caller `cli` / PERSON_SURFACES as the owner when meta carries a member's session token.

import { PERSON_SURFACES } from "./person-surfaces.js";
import { callerKind } from "../core/modules/index.js";

/** @param {any} kernel @param {string} id */
export function canonPerson(kernel, id) {
  return (kernel && typeof kernel.canonicalPerson === "function") ? kernel.canonicalPerson(String(id)) : String(id);
}

/**
 * The single person on a proven kernel chain, or null.
 * @param {any} kernel
 * @param {any} meta
 * @returns {Promise<string|null>}
 */
export async function chainPerson(kernel, meta) {
  if (!kernel || typeof kernel.chain !== "function" || !meta || (!meta.token && !meta.kernelFacts)) return null;
  try {
    const c = await kernel.chain(meta);
    const hops = c && Array.isArray(c.hops) ? c.hops : [];
    const people = hops.filter((/** @type {any} */ h) => h.actor && h.actor.kind === "person");
    if (people.length !== 1) return null;
    return String(people[0].actor.id);
  } catch {
    return null;
  }
}

/** @param {any} kernel @param {string} personId */
export async function membershipRole(kernel, personId) {
  if (!kernel || !personId || typeof kernel.membership !== "function") return null;
  try {
    const m = await kernel.membership(canonPerson(kernel, personId), kernel.space);
    return m && m.role ? String(m.role) : null;
  } catch {
    return null;
  }
}

/** Owner, admin, or the home's owner id (staff sees owner-wide data). @param {any} kernel @param {string} personId */
export async function isStaffPerson(kernel, personId) {
  if (!kernel || !personId) return false;
  if (canonPerson(kernel, personId) === canonPerson(kernel, String(kernel.owner))) return true;
  const role = await membershipRole(kernel, personId);
  return role === "owner" || role === "admin";
}

/**
 * Whether an unnamed-agent read should see the whole home (projects, files roots, etc.), not a member slice.
 * With the kernel on, a member on `cli` with her session token is never owner-wide.
 * @param {any} kernel
 * @param {any} meta
 * @param {string} caller
 * @param {{ ownerDevice?: (c: string) => boolean, reachOwner?: (c: string) => boolean, reachOwnSession?: (c: string) => boolean }} [o]
 */
export async function ownerWideRead(kernel, meta, caller, o = {}) {
  const person = await chainPerson(kernel, meta);
  if (person) return await isStaffPerson(kernel, person);
  if (!kernel) {
    if (meta && (meta.token || meta.kernelFacts)) return false;
    const c = String(caller || "");
    if (c.startsWith("module:")) return true;
    if (o.ownerDevice && o.ownerDevice(c)) return true;
    if (o.reachOwnSession && o.reachOwnSession(c)) return true;
    if (o.reachOwner && o.reachOwner(c)) return true;
    return PERSON_SURFACES.includes(callerKind(c));
  }
  if (meta && (meta.token || meta.kernelFacts)) return false;
  const c = String(caller || "");
  if (c.startsWith("module:")) return true;
  if (o.ownerDevice && o.ownerDevice(c)) return true;
  if (o.reachOwnSession && o.reachOwnSession(c)) return true;
  if (o.reachOwner && o.reachOwner(c)) return true;
  return PERSON_SURFACES.includes(callerKind(c));
}

/**
 * Projects a member may reach (same seat rule as projects.list).
 * @param {any} ctx module ctx with call()
 * @param {any} P Projects instance with list()
 * @param {string} personId
 */
export async function memberReachProjects(ctx, P, personId) {
  const raw = P.list().projects || [];
  const seated = await Promise.all(raw.map(async (/** @type {any} */ p) => {
    const s = await ctx.call("work.project.seat", { project: String(p.slug), person: String(personId) }).then((/** @type {any} */ r) => (r && !r.error ? r.data : null), () => null);
    return Boolean(s && s.exists && (s.owner || s.team)) ? p : null;
  }));
  return seated.filter(Boolean).map((/** @type {any} */ p) => ({
    slug: p.slug,
    name: p.name,
    folders: p.workspaces ? [p.home, ...p.workspaces] : [p.home],
    threads: p.picks || [],
  }));
}

/** Who started a thread run, from threads_runs.opts.person. @param {any} db @param {string} threadId */
export function threadRunPerson(db, threadId) {
  try {
    const row = /** @type {any} */ (db.prepare("SELECT opts FROM threads_runs WHERE id = ?").get(String(threadId)));
    if (!row || !row.opts) return null;
    const o = JSON.parse(String(row.opts));
    return o && o.person ? String(o.person) : null;
  } catch {
    return null;
  }
}

/**
 * Recall sessions attributed to a person (Switchboard record).
 * @param {any} ctx
 * @param {string} personId
 * @returns {Promise<string[]>}
 */
export async function recallSessionsForPerson(ctx, personId) {
  const r = await ctx.call("threads.recall-sessions", { person: String(personId) });
  return r && r.data && Array.isArray(r.data.sessions) ? r.data.sessions.map(String) : [];
}

/**
 * Member-scoped recall reach, or null when caller is staff / owner-wide.
 * @param {any} ctx recall module ctx
 * @param {any} meta
 * @param {(m: string) => Error} denied
 */
export async function recallMemberReach(ctx, meta, denied) {
  const K = ctx.kernel;
  const person = await chainPerson(K, meta);
  if (!person) return null;
  if (await isStaffPerson(K, person)) return null;
  const sessions = await recallSessionsForPerson(ctx, person);
  return { all: false, agent: null, folders: [], member: person, sessions, empty: !sessions.length };
}

/**
 * Filter indexed recall hits to a member's sessions (and subagent children).
 * @param {any} db
 * @param {string[]} allowed
 * @param {any[]} hits
 */
export function recallMemberHits(db, allowed, hits) {
  const set = new Set(allowed);
  return hits.filter(h => {
    if (set.has(h.session)) return true;
    const row = /** @type {any} */ (db.prepare("SELECT parent FROM recall_sessions WHERE id = ?").get(h.session));
    return row && row.parent && set.has(String(row.parent));
  });
}

/**
 * Thread ids a member may see in threads.list (null = staff / owner-wide: no filter).
 * @param {any} ctx module ctx with call()
 * @param {any} kernel
 * @param {any} meta
 * @returns {Promise<Set<string>|null>}
 */
export async function memberThreadAllowSet(ctx, kernel, meta) {
  const person = await chainPerson(kernel, meta);
  if (!person || !kernel || await isStaffPerson(kernel, person)) return null;
  const sessions = await recallSessionsForPerson(ctx, person);
  return new Set(sessions.map(String));
}
