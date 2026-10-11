// @ts-check
// Who may WRITE the three record types that every member can READ but that decide who sees what: a project, its team (team-member rows) and a task. A project's team opens its files, its records and its
// memory; a team-member row also decides who a Flow's pool ask and a project stage's doer reaches; a task moves between projects. So a member writes them only where she owns or belongs, and never gives herself
// a seat. The owner, an admin and the work service's own chain always pass (`ctx.trusted`).
//
// This file only judges. The caller (the gateway's write path, one call site) hands it what it already knows so nothing here reads a record on its own:
//   chain  the caller's chain; ctx = {
//     op        "create" | "update" | "remove"
//     trusted   true for an owner or admin acting as themselves and for the work service's own chain
//     project   async (ref: urn or id) => { owner: string | null, team: string[] } | null   the project's owner person id and the person ids on its team (null: no such project)
//     task      async (id) => { doer: {kind,id} | null, assigned_by: {kind,id} | null, project: string | null } | null
//   }
//   row    the stored record before the write ({ id, data }), null on create;  patch  the fields being written ({} on remove).
// It returns true, or throws KernelError("not_allowed", words that name who can do it).

import { KernelError } from "../core/errors.js";

/** The three types this file judges. */
export const OWNED_TYPES = Object.freeze(["project", "team-member", "task"]);

const no = (/** @type {string} */ message) => new KernelError("not_allowed", message);
/** The person id of an actor value as a record holds it: { actor: { id } }, { id } or a bare string. @param {any} a */
const idOf = a => (a && typeof a === "object" ? (a.actor && a.actor.id) || a.id || null : typeof a === "string" ? a : null);
/** The urn or id a link value names. @param {any} v */
const refOf = v => (v && typeof v === "object" ? (typeof v.urn === "string" ? v.urn : null) : typeof v === "string" ? v : null);
/** The persons and agents on a chain. @param {any} chain */
const actorsOf = chain => (chain && Array.isArray(chain.hops) ? chain.hops.map((/** @type {any} */ h) => h.actor).filter(Boolean) : []);

/**
 * May this chain write this row of this type. @param {any} chain @param {string} type @param {any} row @param {any} patch
 * @param {{ op: "create" | "update" | "remove", trusted: boolean, project: (ref: string) => Promise<{ owner: string | null, team: string[] } | null>, task?: (id: string) => Promise<any> }} ctx
 */
export async function mayWrite(chain, type, row, patch, ctx) {
  if (!OWNED_TYPES.includes(type) || ctx.trusted) return true;
  const me = actorsOf(chain).find((/** @type {any} */ a) => a.kind === "person");
  if (!me) throw no(`only a person, or the owner or an admin, writes a ${type}. Ask the project's owner or an admin.`);
  const person = String(me.id);
  const p = patch && typeof patch === "object" ? patch : {};
  const data = (row && row.data) || {};
  const ownsOrBelongs = (/** @type {{ owner: string | null, team: string[] } | null} */ pr) => Boolean(pr && (pr.owner === person || pr.team.includes(person)));
  const ownsIt = (/** @type {{ owner: string | null, team: string[] } | null} */ pr) => Boolean(pr && pr.owner === person);

  if (type === "project") {
    if (ctx.op === "create") {
      if (p.owner !== undefined && p.owner !== null && idOf(p.owner) !== person) throw no("a project you make is yours: leave the owner out or name yourself. An owner or admin makes one for someone else.");
      return true;
    }
    const pr = await ctx.project(String(row && row.id));
    if (Object.prototype.hasOwnProperty.call(p, "owner") && idOf(p.owner) !== idOf(data.owner)) throw no("a project's owner is changed by an owner or admin, not by a member. Ask one of them.");
    if (ctx.op === "remove") { if (!ownsIt(pr)) throw no("only the project's owner, or an owner or admin, removes a project."); return true; }
    if (!ownsOrBelongs(pr)) throw no("you are not on this project's team. Ask the project's owner to add you.");
    return true;
  }

  if (type === "team-member") {
    // the team opens the project's files and records: only the project's owner changes it. A row on something that is not a project has no owner a member could be: an owner or admin writes it.
    const refs = new Set();
    if (ctx.op !== "create") refs.add(refOf(data.project));
    if (ctx.op !== "remove") refs.add(Object.prototype.hasOwnProperty.call(p, "project") || ctx.op === "create" ? refOf(p.project) : refOf(data.project));
    for (const ref of refs) {
      if (!ref) throw no("a team seat belongs to a project. An owner or admin writes one with no project.");
      if (!ownsIt(await ctx.project(ref))) throw no("only the project's owner, or an owner or admin, changes who is on its team.");
    }
    return true;
  }

  // a task: its doer, whoever assigned it, or the owner or team of its project; and never into a project she is not on
  const t = ctx.op === "create" || !ctx.task || !row ? null : await ctx.task(String(row.id));
  const mine = (/** @type {any} */ a) => Boolean(a) && actorsOf(chain).some((/** @type {any} */ x) => x.kind === a.kind && x.id === a.id);
  const currentProject = ctx.op === "create" ? null : refOf(data.project) || (t && t.project) || null;
  const moveTo = Object.prototype.hasOwnProperty.call(p, "project") ? refOf(p.project) : undefined;
  if (moveTo || (ctx.op === "create" && refOf(p.project))) {
    const target = /** @type {string} */ (moveTo || refOf(p.project));
    if (!ownsOrBelongs(await ctx.project(target))) throw no("a task goes only into a project you are on. Ask the project's owner to add you first.");
  }
  if (ctx.op === "create") return true;
  if (t && (mine(t.doer) || mine(t.assigned_by))) return true;
  if (currentProject && ownsOrBelongs(await ctx.project(currentProject))) return true;
  throw no("a task is changed by whoever it is for, whoever gave it, or its project's owner or team. Ask one of them.");
}
