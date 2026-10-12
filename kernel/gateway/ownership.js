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

/**
 * The services whose one-hop chain writes these types for the whole Space, each trusted because the service checks the person itself BEFORE it writes (a service not listed here is judged as acting for the
 * person a task is for: see actingForOf):
 *   work    the member door takes the chain's one person and refuses a non-member (core/work/member-tools.js who/isMember); a member's own projects are written under HER chain (core/work/member-projects.js);
 *           the work service's chain writes only the hub's bookkeeping for a project it made (drive_path, marker, seats). I did not audit every other work tool.
 *   tasks   kernel/tasks/tasks.js: edit, skip, reopen, unblock and request run this same rule (ownsWrite) and isDoer / checkersOf before the service writes the task's record.
 *   flows   a Flow runs as the person who approved its version and every step is bound to that approval (kernel/flows/runner.js approve, kernel/flows/stages.js).
 *   kernel  the kernel's own bookkeeping (a task's status, tasks.move): actsAsKernel in kernel/gateway/records.js.
 * @type {readonly string[]}
 */
export const TRUSTED_SERVICES = Object.freeze(["work", "tasks", "flows", "kernel"]);

/**
 * When a service that is not trusted writes a task (the planner files a to-do with its own chain), it acts for the task's person: that person is judged as the writer, so a member's to-do goes only into a
 * project she is on, and an owner's anywhere. Null when the chain has a person hop of its own or the task is not a person's. @param {any} chain @param {any} doer
 */
export function actingForOf(chain, doer) {
  const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
  if (!hops.length || hops.some((/** @type {any} */ h) => h.actor.kind === "person") || hops[hops.length - 1].actor.kind !== "service") return null;
  return doer && doer.kind === "person" ? String(doer.id) : null;
}

/** The three types this file judges. */
export const OWNED_TYPES = Object.freeze(["project", "team-member", "task"]);

/** Project fields that point at files, memory, credentials, another Space or whose project is personal: written only by an owner, an admin or the work service, never by a member, even the project's own. */
const PROJECT_TRUSTED_FIELDS = Object.freeze(["drive_path", "memory_scope", "credentials", "moved_to", "moved_from", "personal_of", "slug", "archived_at"]);
/** What a plain team member (not its owner) may change on a project. */
const PROJECT_TEAM_FIELDS = Object.freeze(["name", "status", "due"]);
/** Team seat fields that route work to a seat (pool and project-role asks resolve from them) or give an assistant its brief: trusted-only. A project's owner seats a plain person. */
const SEAT_TRUSTED_FIELDS = Object.freeze(["role", "instructions", "skills"]);

const no = (/** @type {string} */ message) => new KernelError("not_allowed", message);
/** The person id of an actor value as a record holds it: { actor: { id } }, { id } or a bare string. @param {any} a */
const idOf = a => (a && typeof a === "object" ? (a.actor && a.actor.id) || a.id || null : typeof a === "string" ? a : null);
/** The urn or id a link value names. @param {any} v */
const refOf = v => (v && typeof v === "object" ? (typeof v.urn === "string" ? v.urn : null) : typeof v === "string" ? v : null);
/** The persons and agents on a chain. @param {any} chain */
const actorsOf = chain => (chain && Array.isArray(chain.hops) ? chain.hops.map((/** @type {any} */ h) => h.actor).filter(Boolean) : []);

/**
 * May this chain write this row of this type. @param {any} chain @param {string} type @param {any} row @param {any} patch
 * @param {{ op: "create" | "update" | "remove", trusted: boolean, actingFor?: string | null, project: (ref: string) => Promise<{ owner: string | null, team: string[] } | null>, task?: (id: string) => Promise<any> }} ctx
 */
export async function mayWrite(chain, type, row, patch, ctx) {
  if (!OWNED_TYPES.includes(type) || ctx.trusted) return true;
  const acting = ctx.actingFor ? [...actorsOf(chain), { kind: "person", id: ctx.actingFor }] : actorsOf(chain);
  const me = acting.find((/** @type {any} */ a) => a.kind === "person");
  // a project and its team are written by people; a task also by the agent it is for, so only those two need a person here
  if (!me && type !== "task") throw no(`only a person, or the owner or an admin, writes a ${type}. Ask the project's owner or an admin.`);
  const person = me ? String(me.id) : "";
  const p = patch && typeof patch === "object" ? patch : {};
  const data = (row && row.data) || {};
  const ownsOrBelongs = (/** @type {{ owner: string | null, team: string[] } | null} */ pr) => Boolean(pr && (pr.owner === person || pr.team.includes(person)));
  const ownsIt = (/** @type {{ owner: string | null, team: string[] } | null} */ pr) => Boolean(pr && pr.owner === person);

  /** The keys of a patch that change the stored value. @param {any} cur */
  const changed = (/** @type {any} */ cur) => Object.keys(p).filter(k => JSON.stringify(p[k]) !== JSON.stringify(cur ? cur[k] : undefined));

  if (type === "project") {
    if (ctx.op === "create") {
      if (p.owner !== undefined && p.owner !== null && idOf(p.owner) !== person) throw no("a project you make is yours: leave the owner out or name yourself. An owner or admin makes one for someone else.");
      // slug is hers to choose, and the hub gives a new project its own memory scope (project:<slug>); nothing else in the list is set by a member making a project
      const bad = PROJECT_TRUSTED_FIELDS.find(k => k !== "slug" && p[k] !== undefined && p[k] !== null && p[k] !== "" && !(k === "memory_scope" && p.slug && p[k] === `project:${p.slug}`));
      if (bad) throw no(`${bad} is set by Vyre or an owner or admin, not by a member making a project. Leave it out.`);
      return true;
    }
    const pr = await ctx.project(String(row && row.id));
    if (Object.prototype.hasOwnProperty.call(p, "owner") && idOf(p.owner) !== idOf(data.owner)) throw no("a project's owner is changed by an owner or admin, not by a member. Ask one of them.");
    if (ctx.op === "remove") { if (!ownsIt(pr)) throw no("only the project's owner, or an owner or admin, removes a project."); return true; }
    if (!ownsOrBelongs(pr)) throw no("you are not on this project's team. Ask the project's owner to add you.");
    const edits = changed(data).filter(k => k !== "owner");
    const blocked = edits.find(k => PROJECT_TRUSTED_FIELDS.includes(k));
    if (blocked) throw no(`${blocked} points at files, memory or credentials and is changed by an owner or admin. Ask one of them.`);
    if (!ownsIt(pr)) { const extra = edits.find(k => !PROJECT_TEAM_FIELDS.includes(k)); if (extra) throw no(`a team member changes a project's ${PROJECT_TEAM_FIELDS.join(", ")}, not its ${extra}. Ask the project's owner.`); }
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
    // a project's owner adds a PERSON to her own project as a plain member. Anything that routes work to the seat (role, skills), an assistant's brief, or an assistant or agent seat is for an owner or admin.
    const seatKind = Object.prototype.hasOwnProperty.call(p, "kind") ? p.kind : data.kind;
    const actorKind = Object.prototype.hasOwnProperty.call(p, "actor") ? (p.actor && p.actor.actor ? p.actor.actor.kind : null) : (data.actor && data.actor.actor ? data.actor.actor.kind : null);
    if (ctx.op !== "remove" && ((seatKind !== undefined && seatKind !== "person") || (actorKind !== null && actorKind !== "person"))) throw no("a project's owner seats a person. An assistant or agent seat is added by an owner or admin.");
    if (ctx.op !== "remove") { const k = changed(data).find(x => SEAT_TRUSTED_FIELDS.includes(x) && p[x] !== "" && p[x] !== null); if (k) throw no(`${k} decides which work reaches the seat, so an owner or admin sets it. A project's owner adds a person without it.`); }
    return true;
  }

  // a task: its doer, whoever assigned it, or the owner or team of its project; and never into a project she is not on
  const t = ctx.op === "create" || !ctx.task || !row ? null : await ctx.task(String(row.id));
  const mine = (/** @type {any} */ a) => Boolean(a) && acting.some((/** @type {any} */ x) => x.kind === a.kind && x.id === a.id);
  const currentProject = ctx.op === "create" ? null : refOf(data.project) || (t && t.project) || null;
  const moveTo = Object.prototype.hasOwnProperty.call(p, "project") ? refOf(p.project) : undefined;
  if (moveTo || (ctx.op === "create" && refOf(p.project))) {
    const target = /** @type {string} */ (moveTo || refOf(p.project));
    if (!ownsOrBelongs(await ctx.project(target))) throw no("a task goes only into a project you are on. Ask the project's owner to add you first.");
  }
  if (ctx.op === "create") return true;
  const allowed = Boolean(t && (mine(t.doer) || mine(t.assigned_by))) || Boolean(currentProject && ownsOrBelongs(await ctx.project(currentProject)));
  if (allowed) {
    // handing a stuck task to someone else (tasks unblock): the new doer is on the task's project, or, with no project, not herself unless she gave the task
    if (p.reassign_to !== undefined && p.reassign_to !== null) {
      const to = idOf(p.reassign_to), proj = currentProject ? await ctx.project(currentProject) : null;
      if (proj ? !(proj.owner === to || proj.team.includes(String(to))) : (to === person && !(t && mine(t.assigned_by)))) throw no("a task is handed only to someone on its project, and not to yourself unless you gave it. Ask the project's owner.");
    }
    return true;
  }
  throw no("a task is changed by whoever it is for, whoever gave it, or its project's owner or team. Ask one of them.");
}

/** The owner or an admin acting as themselves (or through a service they started), or the owning service's own one-hop chain. @param {any} chain @param {(a: any) => string | null | undefined} roleOf */
export function isTrustedChain(chain, roleOf) {
  const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
  if (hops.length === 1 && hops[0].actor.kind === "service" && TRUSTED_SERVICES.includes(hops[0].actor.id)) return true;
  const first = hops.find((/** @type {any} */ h) => h.actor.kind === "person");
  if (!first) return false;
  const role = roleOf(first.actor);
  return (role === "owner" || role === "admin") && (hops.length === 1 || hops[hops.length - 1].actor.kind === "service");
}

/** The owner and the people on a project's team, read straight from the record store (no gate: the rule's own question). @param {{ get: Function, query: Function }} store @param {(type: string, id: string) => string} urn @param {(urn: string) => any} [attrsOf] */
export const projectTeamOf = (store, urn, attrsOf = undefined) => async (/** @type {string} */ ref) => {
  const pid = String(ref).split("/").pop() || "";
  const pr = await store.get("project", pid).catch(() => null);
  if (!pr) return null;
  const rows = ((await store.query("team-member", { filter: { field: "project", op: "eq", value: { urn: urn("project", pid) } }, page: { limit: 500 } }).catch(() => ({ rows: [] }))).rows) || [];
  // the owner is the project's owner field; a project with none belongs to the kernel's record of who owns it, then who made it
  const at = typeof attrsOf === "function" ? attrsOf(urn("project", pid)) || {} : {};
  const made = String(at.created_for || at.created_by || ""), madeBy = made.startsWith("person:") ? made.slice(7) : null;
  return { owner: idOf(pr.data.owner) || (at.owner ? String(idOf(at.owner) || at.owner) : null) || madeBy, team: rows.filter((/** @type {any} */ r) => r.data && r.data.kind === "person").map((/** @type {any} */ r) => idOf(r.data.actor)).filter(Boolean) };
};

/**
 * The kernel attributes a record is created with (`owner`, `project`, `sensitivity`), for ANY type: a member may not name another person as the owner, set its sensitivity or file a record under a
 * project she is not on. @param {any} chain @param {any} attrs @param {{ trusted: boolean, project: (ref: string) => Promise<{ owner: string | null, team: string[] } | null> }} ctx
 */
export async function mayAttrs(chain, attrs, ctx) {
  if (ctx.trusted || !attrs || typeof attrs !== "object") return true;
  const me = actorsOf(chain).find((/** @type {any} */ a) => a.kind === "person");
  const person = me ? String(me.id) : "";
  if (attrs.sensitivity !== undefined) throw no("a record's sensitivity is set by an owner or admin. Leave it out.");
  if (attrs.owner !== undefined && idOf(attrs.owner) !== person) throw no("a record you make is yours: leave the owner out or name yourself.");
  if (attrs.project !== undefined && attrs.project !== null) {
    const pr = await ctx.project(String(refOf(attrs.project) || attrs.project));
    if (!(pr && (pr.owner === person || pr.team.includes(person)))) throw no("a record goes only under a project you are on. Ask the project's owner to add you first.");
  }
  return true;
}

/** Who is writing and whether that is trusted: the chain as it is, or, for a service that is not trusted, the person the task is for (an owner or admin there counts as trusted). @param {any} chain @param {any} doer @param {(a: any) => string | null | undefined} roleOf @param {string} space */
export function judgeWriter(chain, doer, roleOf, space) {
  const actingFor = actingForOf(chain, doer);
  const trusted = isTrustedChain(chain, roleOf) || (actingFor !== null && ["owner", "admin"].includes(String(roleOf({ kind: "person", id: actingFor, space }))));
  return { trusted, actingFor };
}
