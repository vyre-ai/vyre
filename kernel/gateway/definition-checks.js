// @ts-check
// The checks a type definition passes before the gateway accepts it (kinds, roles, computed fields, names, shape): they read the definition and the Space's current types and refuse in words. They decide no
// grant and read no record, so they sit outside the counted trusted base; records.js calls them from `define` and the gateway still gates the define itself.
import { KernelError } from "../core/errors.js";
import { exprNames } from "../../lib/expr/expr.js";
import { stageNamesOf } from "../../lib/expr/conditions.js";

export const TYPE_NAME = /^[a-z][a-z0-9_-]*$/;

/** @param {{ store: any, parseComputed: (src: string) => any }} d */
export function createDefinitionChecks({ store, parseComputed }) {
  function checkKinds(/** @type {any} */ diff) {
    for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) if (t.kind !== undefined && t.kind !== "project") throw new KernelError("bad_input", `${t.name}: kind is "project" or left out`);
  }

  /** A role type points at one contact or organization through one required link, and names stages that already exist. */
  async function checkRoles(/** @type {any} */ diff) {
    for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) {
      if (t.role === undefined) continue;
      const bad = (/** @type {string} */ why) => new KernelError("bad_input", `${t.name} cannot be a role: ${why}`);
      if (!t.role || typeof t.role.link !== "string") throw bad("it needs role.link, the field that names who holds it");
      const f = (t.fields || []).find((/** @type {any} */ x) => x.name === t.role.link);
      if (!f || f.kind !== "link" || (f.to !== "contact" && f.to !== "organization")) throw bad(`${t.role.link} must be a link to a contact or an organization`);
      if (f.required !== true) throw bad(`${t.role.link} must be required, so a role never exists without its holder`);
      if (t.role.ended !== undefined) {
        const sf = (t.fields || []).find((/** @type {any} */ x) => x.kind === "stage");
        const names = (t.stages || []).map((/** @type {any} */ s) => s.name).concat(sf && sf.options ? sf.options : []);
        if (!Array.isArray(t.role.ended) || !t.role.ended.every((/** @type {any} */ e) => names.includes(e))) throw bad("role.ended names stages the type does not have");
      }
    }
  }
  const COMPUTED_KINDS = new Set(["number", "text", "boolean", "date", "datetime"]);
  const OVER_FNS = new Set(["count", "sum", "min", "max", "avg"]);
  /** A computed field names its kind, and either an expression over this type's other fields or a total over the records that link to it. */
  async function checkComputed(/** @type {any} */ diff) {
    for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) for (const f of t.fields || []) {
      if (f.computed === undefined) continue;
      const bad = (/** @type {string} */ why) => new KernelError("bad_input", `${t.name}.${f.name} cannot be computed: ${why}`);
      const c = f.computed;
      if (!c || typeof c !== "object" || (c.expr === undefined) === (c.over === undefined)) throw bad("give either expr or over");
      if (!COMPUTED_KINDS.has(f.kind)) throw bad(`a computed field is a ${[...COMPUTED_KINDS].join(", ")} field`);
      if (c.expr !== undefined) {
        let tree; try { tree = parseComputed(String(c.expr)); } catch (e) { throw bad(String(/** @type {any} */ (e).message)); }
        for (const n of exprNames(tree)) {
          const g = t.fields.find((/** @type {any} */ x) => x.name === n);
          if (!g) throw bad(`the expression names ${n}, which is not a field of ${t.name}`);
          if (g.kind === "sealed") throw bad(`${n} is sealed and cannot be used in an expression`);
          if (g.computed) throw bad(`${n} is computed too: a computed field reads stored fields only`);
        }
      } else {
        const o = c.over;
        if (!o || typeof o.type !== "string" || typeof o.via !== "string" || !OVER_FNS.has(o.fn) || (o.fn !== "count" && typeof o.field !== "string")) throw bad("over is { type, via, fn: count|sum|min|max|avg, field (not for count) }");
        let defs = []; try { defs = typeof store.types === "function" ? await store.types() : []; } catch { /* checked when the other type is read */ }
        const other = [...defs, ...(diff.add_types || []), ...(diff.change_types || [])].find((/** @type {any} */ x) => x.name === o.type);
        if (other) {
          const via = other.fields.find((/** @type {any} */ x) => x.name === o.via);
          if (!via || via.kind !== "link" || (via.to !== undefined && via.to !== t.name)) throw bad(`${o.type}.${o.via} must be a link to ${t.name}`);
          const meas = o.field ? other.fields.find((/** @type {any} */ x) => x.name === o.field.split(".")[0]) : null;
          if (o.field && !meas) throw bad(`${o.type} has no field ${o.field}`);
          if (meas && (meas.kind === "sealed" || meas.computed)) throw bad(`${o.field} cannot be measured`);
        }
      }
    }
  }
  /**
   * A person's new type needs its own label: a second type with the label of one the Space already has (another name, same words) is refused. An add of an existing name is
   * not a new type (it is how a module or a Kit says what it needs again), and the store refuses anything that would take fields away.
   */
  async function checkNames(/** @type {any} */ diff, /** @type {any} */ chain, /** @type {any} */ o) {
    const adding = diff.add_types || [];
    // Only a person's own define: a seed by the kernel or a module (a service in the chain, or an approved Kit's waiver) says what it needs again and is never a second copy
    const personal = chain.hops.length === 1 && chain.hops[0].actor.kind === "person" && o.waiver === undefined;
    if (!adding.length || !personal) return;
    let defs = []; try { defs = typeof store.types === "function" ? await store.types() : []; } catch { /* the store says so when it defines */ }
    const words = (/** @type {any} */ s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const seen = new Map();
    for (const t of adding) {
      const label = words(t.label || t.name);
      const same = defs.find((/** @type {any} */ d) => d.name === t.name);
      if (!same) {
        const twin = defs.find((/** @type {any} */ d) => words(d.label || d.name) === label) || (seen.has(label) && seen.get(label) !== t.name ? { label: t.label } : null);
        if (twin) throw new KernelError("type_exists", `There is already a type called ${twin.label || t.label}. Pick another name, or open the one you have.`);
      }
      seen.set(label, t.name);
    }
  }
  const VIEW_TYPES = new Set(["list", "board", "calendar", "page", "dashboard"]);
  const VIEW_KEYS = new Set(["name", "type", "label", "groupBy", "dateField", "columns", "filter", "sort"]);
  /**
   * Conditional fields (visible_if, required_if), stage entry conditions (enter_if), stage sets and stored views: the expressions parse, they read this type's own stored
   * fields (never a sealed one), and a stage set is picked by the record's other fields, never by its stage.
   */
  /** A group name is UI text: a string of 1 to 60 characters, trimmed, no control characters or line breaks. @param {unknown} n */
  const groupName = (n) => typeof n === "string" && n.length > 0 && n.length <= 60 && n === n.trim() && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(n);
  async function checkShape(/** @type {any} */ diff) {
    // a field the kernel owns stays the kernel's: a change to a type cannot take `owned_by` off it, or an owner could then set a task's status by hand
    if ((diff.change_types || []).length) {
      let defs = []; try { defs = typeof store.types === "function" ? await store.types() : []; } catch { /* the store says so when it defines */ }
      for (const t of diff.change_types) {
        const was = defs.find((/** @type {any} */ d) => d.name === t.name);
        for (const f of (was && was.fields) || []) if (f.owned_by !== undefined && !(t.fields || []).some((/** @type {any} */ x) => x.name === f.name && x.owned_by === f.owned_by)) throw new KernelError("bad_input", `${t.name}.${f.name} is kept by the kernel: a change cannot take that away`);
      }
    }
    for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) {
      const bad = (/** @type {string} */ why) => new KernelError("bad_input", `${t.name}: ${why}`);
      const fields = t.fields || [];
      const sf = fields.find((/** @type {any} */ x) => x.kind === "stage");
      /** Parse `src` and check every name it reads. @param {string} what @param {unknown} src @param {string[]} [not] names it may not read */
      const reads = (what, src, not = []) => {
        if (typeof src !== "string" || !src.length) throw bad(`${what} is an expression`);
        let tree; try { tree = parseComputed(src); } catch (e) { if (e instanceof KernelError) throw e; throw bad(`${what}: ${String(/** @type {any} */ (e).message)}`); }
        for (const n of exprNames(tree)) {
          const g = fields.find((/** @type {any} */ x) => x.name === n);
          if (!g) throw bad(`${what} names ${n}, which is not a field of ${t.name}`);
          if (g.kind === "sealed") throw bad(`${what} names ${n}, which is sealed`);
          if (not.includes(n)) throw bad(`${what} cannot name ${n}`);
        }
      };
      // groups are presentation: the sections of the type in order, and each field's section. Never a permission.
      if (t.groups !== undefined) {
        if (!Array.isArray(t.groups) || t.groups.length > 20) throw bad("groups is a list of at most 20 sections");
        const names = new Set();
        for (const g of t.groups) {
          if (!g || typeof g !== "object" || Object.keys(g).some((/** @type {string} */ x) => x !== "name" && x !== "collapsed")) throw bad("a group is { name, collapsed? } and nothing else");
          if (!groupName(g.name)) throw bad("a group has a name of 1 to 60 characters with no spaces at the ends, no line breaks and no control characters");
          if (g.collapsed !== undefined && typeof g.collapsed !== "boolean") throw bad(`${g.name}.collapsed is true or false`);
          if (names.has(g.name.toLowerCase())) throw bad(`two groups are called ${g.name}`);
          names.add(g.name.toLowerCase());
        }
      }
      for (const f of fields) {
        if (f.group !== undefined && (!groupName(f.group) || !(t.groups || []).some((/** @type {any} */ g) => g.name === f.group))) throw bad(`${f.name}.group is one of the type's groups`);
        if (f.format !== undefined && f.format !== "time_zone") throw bad(`${f.name}: format is "time_zone" or left out`);
        if (f.owned_by !== undefined && f.owned_by !== "kernel") throw bad(`${f.name}: owned_by is "kernel" or left out`);
        if (f.visible_if !== undefined) reads(`${f.name}.visible_if`, f.visible_if, [f.name]);
        if (f.required_if !== undefined) { reads(`${f.name}.required_if`, f.required_if, [f.name]); if (f.required === true) throw bad(`${f.name} is required or required_if, not both`); }
        if (f.visible_if !== undefined && f.required === true) throw bad(`${f.name} is only sometimes shown, so it cannot be always required: use required_if`);
      }
      const sets = t.stage_sets;
      if (sets !== undefined) {
        if (!Array.isArray(sets) || !sf) throw bad("stage_sets need a stage field and a list of sets");
        const seen = new Set();
        for (const set of sets) {
          if (!set || typeof set.name !== "string" || !Array.isArray(set.stages) || !set.stages.length) throw bad("a stage set has a name, a when and stages");
          if (seen.has(set.name)) throw bad(`two stage sets are named ${set.name}`); seen.add(set.name);
          reads(`stage set ${set.name}.when`, set.when, [sf.name]);
        }
      }
      // With stage sets, the stage field must offer every stage any set can put a record in (a definition without sets is as it always was).
      if (sf && sets) {
        const names = stageNamesOf(t);
        if (!Array.isArray(sf.options) || !names.every((/** @type {string} */ n) => sf.options.includes(n))) throw bad("the stage field's options must include every stage of the default stages and of every stage set");
      }
      for (const st of [...(t.stages || []), ...(sets || []).flatMap((/** @type {any} */ x) => x.stages)]) if (st.enter_if !== undefined) reads(`stage ${st.name}.enter_if`, st.enter_if, sf ? [sf.name] : []);
      if (t.views !== undefined) {
        if (!Array.isArray(t.views) || t.views.length > 30) throw bad("views is a list of up to 30 views");
        const names = new Set();
        for (const v of t.views) {
          if (!v || typeof v !== "object" || typeof v.name !== "string" || !TYPE_NAME.test(v.name)) throw bad("a view has a name");
          if (names.has(v.name)) throw bad(`two views are named ${v.name}`); names.add(v.name);
          for (const k of Object.keys(v)) if (!VIEW_KEYS.has(k)) throw bad(`view ${v.name}: unknown key ${k}`);
          if (!VIEW_TYPES.has(v.type)) throw bad(`view ${v.name}: type is one of ${[...VIEW_TYPES].join(", ")}`);
          const field = (/** @type {string} */ n) => fields.find((/** @type {any} */ x) => x.name === n);
          if (v.groupBy !== undefined && !["stage", "choice"].includes((field(v.groupBy) || {}).kind)) throw bad(`view ${v.name}: groupBy is a stage or choice field`);
          if (v.type === "board" && v.groupBy === undefined) throw bad(`view ${v.name}: a board needs groupBy`);
          if (v.dateField !== undefined && !["date", "datetime"].includes((field(v.dateField) || {}).kind)) throw bad(`view ${v.name}: dateField is a date field`);
          if (v.type === "calendar" && v.dateField === undefined) throw bad(`view ${v.name}: a calendar needs dateField`);
          if (v.columns !== undefined && (!Array.isArray(v.columns) || v.columns.length > 40 || !v.columns.every((/** @type {string} */ c) => field(c)))) throw bad(`view ${v.name}: columns are fields of ${t.name}`);
          if (v.sort !== undefined && (!v.sort || !field(v.sort.field) || (v.sort.dir !== undefined && !["asc", "desc"].includes(v.sort.dir)))) throw bad(`view ${v.name}: sort is { field, dir }`);
          if (v.filter !== undefined) reads(`view ${v.name}.filter`, v.filter);
        }
      }
    }
  }
  return { checkKinds, checkRoles, checkComputed, checkNames, checkShape };
}
