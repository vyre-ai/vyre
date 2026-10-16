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

// Firm-key modules (Google, Microsoft 365): which accounts a call may use. The person comes from the kernel chain, never from input.
const firmDenied = (m) => Object.assign(new Error(m), { code: "denied" });
const EMAIL_DOMAIN = (e) => String(e || "").toLowerCase().split("@")[1] || "";

/**
 * @param {{ kernel?: any, all: () => any[], memberOf: (id: string) => ({ id: string, email?: string, verified?: boolean } | null | undefined), derive: (all: any[], member: any) => any[] }} d
 * @param {any} meta
 * @returns {Promise<any[] | null>} null: the owner's view; else the member's own
 */
export async function scopeFor(d, meta) {
  const k = d.kernel;
  const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
  if (!k || typeof k.chain !== "function" || !claims) return null;
  let persons;
  try {
    const c = await k.chain(meta);
    persons = (c && Array.isArray(c.hops) ? c.hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id));
  } catch { throw firmDenied("who is asking could not be read, so no account is offered"); }
  const other = persons.filter(p => p !== String(k.owner));
  if (!other.length) return null;
  const rec = d.memberOf(other[other.length - 1]);
  if (!rec) throw firmDenied("this Space has no work email recorded for you, so the firm key cannot act as you");
  return d.derive(d.all(), rec);
}

const OWNER_LABEL = /^(?:cli|local|capsule)$/;

/** @param {any} kernel @param {any} meta */
export async function requireOwner(kernel, meta) {
  const refuse = () => firmDenied("only the Space owner can set which work email a member's firm-key account acts as");
  const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
  if (!kernel || typeof kernel.chain !== "function") throw refuse();
  if (!claims) { if (OWNER_LABEL.test(String((meta && meta.caller) || ""))) return; throw refuse(); }
  let persons;
  try {
    const c = await kernel.chain(meta);
    persons = (c && Array.isArray(c.hops) ? c.hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id));
  } catch { throw refuse(); }
  if (!persons.length || !kernel.owner || persons.some(p => p !== String(kernel.owner))) throw refuse();
}

/** @param {{ email: string, person: string, firmKeys: any[], taken: (email: string) => string | null, owner?: string }} d */
export function emailProblem(d) {
  const domains = d.firmKeys.filter(k => k && k.firm).map(k => String(k.domain || EMAIL_DOMAIN(k.email)).toLowerCase());
  if (!domains.length) return "add the firm key first: a work email only means something against a firm Google Workspace key";
  if (!domains.includes(EMAIL_DOMAIN(d.email))) return `that address is outside the firm key's domain (${domains.join(", ")})`;
  const other = d.taken(d.email);
  if (other && other !== d.person) return "that address is already attested for another person";
  return null;
}
