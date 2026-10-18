// @ts-check
// Per-record privacy for a Space's own record types (roadmap 6): a row that links to a project is read and changed only by that project's team. This file holds the rule, the guard on a link change
// or a merge, and the page-cutting that keeps a cursor from counting rows a reader may not see. The gateway's read and write paths call it in a line each and still decide every answer themselves.
import { KernelError } from "../core/errors.js";
import { isChain } from "../core/chain.js";
import { mayAttrs, mayReadTask, isTrustedChain, workTeamOf, projectTeamOf } from "./ownership.js";

/**
 * @param {{ store: any, urn: (type: string, id: string) => string, attrsOf: (urn: string) => any, builtinRule: (type: string) => boolean, gen: () => number, members: any, roleFor: (a: any) => any,
 *   mayView: (chain: any, type: string, rec: any) => Promise<boolean>, serviceOnly: (chain: any) => boolean, staffOfChain: (chain: any) => boolean }} d
 */
export function createPrivateRows(d) {
  const { store, urn, mayView } = d;
  /** @type {Map<string, { name: string, to: string }[]> | null} the links to a project of every type that has one: a link field to the core Project, or to a type that holds work (a Kit's matter) */
  let map = null;
  const seatOfWork = workTeamOf(store, urn, d.attrsOf);
  /** The definitions changed: build the map again. */
  const invalidate = () => { map = null; };
  /**
   * The link fields of a type that point at a project (the core Project, or a type that says `kind: "project"`), for a type with no rule of its own. A row that fills one is read only by that project's
   * team; a type with none reads as ever. While the definitions cannot be read the answer is an error, never "none".
   * @param {string} type @returns {Promise<{ name: string, to: string }[]>}
   */
  const linksOf = async (type) => {
    if (d.builtinRule(type)) return [];
    if (!map) {
      if (typeof store.types !== "function") return [];
      const gen = d.gen();
      let defs; try { defs = await store.types(); } catch { throw new KernelError("unavailable", "the type definitions could not be read"); }
      const holdsWork = new Set(["project", ...defs.filter((/** @type {any} */ t) => t.kind === "project").map((/** @type {any} */ t) => t.name)]);
      const built = new Map();
      for (const t of defs) {
        if (d.builtinRule(t.name)) continue;
        const links = (t.fields || []).filter((/** @type {any} */ f) => f.kind === "link" && typeof f.to === "string" && holdsWork.has(f.to)).map((/** @type {any} */ f) => ({ name: String(f.name), to: String(f.to) }));
        if (links.length) built.set(t.name, links);
      }
      if (gen !== d.gen()) return built.get(type) || [];
      map = built;
    }
    return map.get(type) || [];
  };
  /** The people allowed a row of a custom type: nobody in particular when it links to no project, else the team of any project it links to. Read from the STORED row: what a caller is shown has had fields cut. */
  const ruleOf = async (/** @type {string} */ type) => {
    const links = await linksOf(type);
    if (!links.length) return null;
    return async (/** @type {string} */ me, /** @type {any} */ rec) => {
      const raw = await store.get(type, rec.id, { include_deleted: true }).catch(() => null);   // a removed row keeps its links: the one who may restore or undo it is its team, not nobody
      if (!raw || !raw.data) return false;
      let linked = false;
      for (const l of links) {
        const v = raw.data[l.name];
        for (const one of Array.isArray(v) ? v : [v]) {
          const ref = one && (typeof one === "string" ? one : one.urn);
          if (!ref) continue;
          linked = true;
          const t = await seatOfWork(String(ref), l.to);
          if (t && (t.owner === me || t.team.includes(me))) return true;
        }
      }
      return !linked;
    };
  };
  /** The writer is on the team of EVERY project any of these row datas links to, and is not a Viewer there (a chain with no person, or a trusted one, passes). */
  async function linkGate(/** @type {any} */ chain, /** @type {string} */ type, /** @type {any[]} */ ...datas) {
    if (!(d.members && typeof d.members.membership === "function" && chain.hops.some((/** @type {any} */ h) => h.actor.kind === "person"))) return;
    for (const l of await linksOf(type)) {
      const refs = new Set();
      for (const x of datas) for (const one of Array.isArray(x && x[l.name]) ? x[l.name] : [x && x[l.name]]) { const ref = one && (typeof one === "string" ? one : one.urn); if (ref) refs.add(String(ref)); }
      for (const ref of refs) await mayAttrs(chain, { project: ref }, { trusted: isTrustedChain(chain, d.roleFor), project: (/** @type {string} */ r) => seatOfWork(r, l.to) });
    }
  }
  /** Joining two rows moves their links and removes one: a row the caller may not read is neither joined nor undone, a type that holds work is joined only by staff, and she must be on the team of every project either row links to. */
  const mergeGuard = async (/** @type {any} */ chain, /** @type {string} */ type, /** @type {string[]} */ ids, /** @type {(type: string) => Promise<boolean>} */ isPrivate) => {
    if (!isChain(chain) || d.serviceOnly(chain) || d.staffOfChain(chain)) return;
    let defs; try { defs = typeof store.types === "function" ? await store.types() : []; } catch { throw new KernelError("unavailable", "the type definitions could not be read"); }
    const def = defs.find((/** @type {any} */ t) => t.name === type);
    if (def && (def.kind === "project" || type === "project")) throw new KernelError("not_allowed", `Only an owner or an admin joins ${def.label || type} records: the records that link to them would follow. Ask one of them.`);
    if (!(await isPrivate(type))) return;
    const datas = [];
    for (const id of ids) { const raw = await store.get(type, id, { include_deleted: true }).catch(() => null); if (!raw || !(await mayView(chain, type, { ...raw, urn: urn(type, id) }))) throw new KernelError("not_found", "no such record"); datas.push(raw.data); }
    await linkGate(chain, type, ...datas);
  };
  /** Do this type's rows read by a rule of their own (a built-in rule, or a link to a project)? */
  const isPrivate = async (/** @type {string} */ type) => d.builtinRule(type) || (await linksOf(type)).length > 0;
  /** For a total over a type that reads by a rule of its own: the check each row must pass to be counted for this chain (undefined when every row reads the same, or the caller is staff or a service). */
  const rowsMayView = async (/** @type {any} */ chain, /** @type {string} */ type) => (!(await isPrivate(type)) || d.serviceOnly(chain) || d.staffOfChain(chain) ? undefined : (/** @type {any} */ rec) => mayView(chain, type, rec));
  return { linksOf, ruleOf, isPrivate, rowsMayView, invalidate, linkGate, mergeGuard };
}

/**
 * A page of the rows a reader may see, from a source that cannot tell: pages are cut to the rows `ok` allows, and a cursor is given only when a row she may read is still ahead (it would otherwise count the others).
 * @param {{ page: { cursor?: string } }} spec @param {(page: any) => Promise<{ rows: any[], next_cursor?: string }>} getPage @param {(row: any) => Promise<boolean>} ok
 */
export async function visiblePage(spec, getPage, ok) {
  // each page asks only for what is still missing, so the cursor lands exactly after the last row examined and nothing is skipped or trimmed; with no limit the first page that has a readable row is the answer
  const want = Number.isInteger(/** @type {any} */ (spec.page).limit) && /** @type {any} */ (spec.page).limit > 0 ? /** @type {any} */ (spec.page).limit : null;
  let cursor = spec.page.cursor, rows = /** @type {any[]} */ ([]), next;
  for (let pages = 0; pages < 10; pages++) {
    const p = await getPage({ ...spec.page, ...(want ? { limit: want - rows.length } : {}), ...(cursor ? { cursor } : {}) });
    for (const x of p.rows) if (await ok(x)) rows.push(x);
    next = p.next_cursor;
    if (!next || (want ? rows.length >= want : rows.length > 0)) break;
    cursor = next;
  }
  let more = false;
  for (let ahead = 0; next && !more && ahead < 10; ahead++) {
    const p = await getPage({ ...spec.page, cursor: next });
    for (const x of p.rows) if (await ok(x)) { more = true; break; }
    if (!more) next = p.next_cursor;
  }
  return { rows, ...(more ? { next_cursor: next } : {}) };
}

/**
 * Types read by a rule of their own, per record (class 3): a communication by the person whose mail it is and the team of the project it concerns; a project by its owner and team; a team row and a task by the
 * people of their project (a task also by its doer and whoever gave it, the same people the write rule names). An owner or an admin reads all; a type NOT listed here reads as ever.
 * An event that came from an outside
 * calendar is read by the person whose calendar it is, unless they shared it with the Space (the others see a Busy block from records.busy). It binds an owner and an admin too (OWN_ONLY). Notes are the planner's Note type and are shared by the planner (core/planner/note-share.js).
 * @param {{ store: any, urn: (type: string, id: string) => string, attrsOf: (urn: string) => any, tasks: any }} d @returns {Record<string, (me: string, rec: any, chain: any) => Promise<boolean>>}
 */
/** Types whose read rule binds an owner and an admin as well: private means private. */
export const OWN_ONLY = Object.freeze(new Set(["event"]));

export function createReadRules(d) {
  const { store, urn, attrsOf } = d;
  const seatOf = projectTeamOf(store, urn, attrsOf);
  const onProject = async (/** @type {string} */ me, /** @type {any} */ link) => { const ref = link && (link.urn || (typeof link === "string" ? link : null)); const t = ref ? await seatOf(String(ref)) : null; return Boolean(t && (t.owner === me || t.team.includes(me))); };
  const taskFacts = async (/** @type {string} */ tid) => { if (d.tasks && typeof d.tasks.facts === "function") return d.tasks.facts(tid); const t = await store.get("task", tid).catch(() => null); return t ? { doer: t.data.doer ?? null, assigned_by: t.data.assigned_by ?? null, project: t.data.project && (t.data.project.urn || t.data.project) ? String(t.data.project.urn || t.data.project) : null } : null; };
  const writer = (/** @type {string} */ me, /** @type {any} */ rec) => { const at = attrsOf(rec.urn) || {}, ow = String(at.owner || at.created_for || ""); return ow === me || ow === `person:${me}`; };
  return {
    event: async (me, rec) => !(rec.data && rec.data.source === "google") || (rec.data && rec.data.visibility === "space") || writer(me, rec),
    communication: async (me, rec) => { const at = attrsOf(rec.urn) || {}, ow = String(at.owner || at.created_for || ""); return ow === me || ow === `person:${me}` || onProject(me, rec.data && rec.data.record); },
    "team-member": (me, rec) => onProject(me, rec.data && rec.data.project),
    project: async (me, rec) => (rec.data && rec.data.personal_of ? String(rec.data.personal_of) === me : onProject(me, { urn: rec.urn })),
    task: async (_me, rec, chain) => { const t = await taskFacts(rec.id); return mayReadTask(chain, { doer: t && t.doer, assigned_by: t && t.assigned_by, project: (rec.data && rec.data.project) || (t && t.project) }, { staff: false, project: seatOf, checkers: t && t.checkers }); },
  };
}