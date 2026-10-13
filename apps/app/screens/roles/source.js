// @ts-check
// Roles over the box (the roles.* tools, answered by roles-core) or, in the sample world, over a small store in memory. One shape for both:
// read() gives the roles, the record types the data section lists and the projects "chosen projects" picks from; the writes answer the stored role.
import { SAMPLE_TYPES, builtInRoles, duplicateRole, newRole, removeRefusal, nameProblem, withTypes } from "./model.js";
import { MOCK_PROJECTS, sampleRoles } from "./mock.js";

/** @typedef {import("./model.js").Role} Role */
/** @typedef {{ roles: Role[], catalogue?: { can: string[][], tools: string[][] } | null, types: { id: string, name: string, fields: string[] }[], projects: { id: string, name: string }[] }} World */

/** The sample world, in memory: it keeps what the owner changes until the page reloads. */
export function mockSource() {
  let roles = sampleRoles();
  /** @type {Set<() => void>} */
  const subs = new Set();
  const tell = () => subs.forEach((f) => f());
  const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
  return {
    subscribe: (/** @type {() => void} */ f) => { subs.add(f); return () => { subs.delete(f); }; },
    read: async () => /** @type {World} */ ({ roles: roles.map((r) => withTypes(r, SAMPLE_TYPES)), types: SAMPLE_TYPES, projects: MOCK_PROJECTS }),
    create: async (/** @type {string} */ from, /** @type {string} */ name) => {
      const bad = nameProblem(name, roles);
      if (bad) throw fail("name_taken", bad);
      const r = newRole(from, name, roles); roles = [...roles, r]; tell(); return r;
    },
    duplicate: async (/** @type {string} */ id) => {
      const src = roles.find((r) => r.id === id);
      if (!src) throw fail("not_found", "That role is gone.");
      const r = duplicateRole(src, roles); roles = [...roles, r]; tell(); return r;
    },
    save: async (/** @type {Role} */ role) => {
      if (!roles.some((r) => r.id === role.id)) throw fail("not_found", "That role is gone.");
      roles = roles.map((r) => (r.id === role.id ? { ...role, holders: r.holders } : r)); tell(); return role;
    },
    remove: async (/** @type {string} */ id) => {
      const r = roles.find((x) => x.id === id);
      const why = r ? removeRefusal(r) : "";
      if (why) throw fail("role_in_use", why);
      roles = roles.filter((x) => x.id !== id); tell();
    },
  };
}

/** The box's where kinds and ours. */
const WHERE_IN = { space: "space", my_projects: "seats", projects: "chosen", mine: "own" };
const WHERE_OUT = { space: "space", seats: "my_projects", chosen: "projects", own: "mine" };

/**
 * The real source over `call` (the app's box connection, or a fake box in a test): roles-core's tools roles.list, roles.get, roles.create, roles.update, roles.remove.
 * @param {(tool: string, input?: Record<string, unknown>) => Promise<{ data?: any, error?: { code: string, message: string } }>} call
 */
export function rolesSource(call) {
  const ask = async (/** @type {string} */ tool, /** @type {Record<string, unknown>} */ input = {}) => {
    const r = await call(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data;
  };
  return {
    subscribe: (/** @type {() => void} */ _f) => () => {},
    read: async () => {
      const [list, types, projects, cat] = await Promise.all([ask("roles.list"), ask("records.types.list").catch(() => null), ask("work.projects.list").catch(() => null), ask("roles.catalogue").catch(() => null)]);
      const ts = typesOf(types);
      const useTypes = ts.length ? ts : SAMPLE_TYPES;
      const rows = rolesOf(list);
      // The list answers a line per role; each role's settings come from roles.get.
      const tmpl = builtInRoles({}, useTypes);
      // A built-in role is a fixed definition the box does not spell out: it is drawn from what each starts as.
      const full = await Promise.all(rows.map(async (row) => { const b = row.builtin ? tmpl.find((t) => t.id === row.id) : null; if (b) return { ...b, holders: row.holders }; try { return { ...roleOf((await ask("roles.get", { id: row.id }))?.role, useTypes), holders: row.holders }; } catch { return row; } }));
      return /** @type {World} */ ({ roles: full.map((r) => withTypes(r, useTypes)), types: useTypes, projects: projectsOf(projects), catalogue: catalogueOf(cat) });
    },
    create: async (/** @type {string} */ _from, /** @type {string} */ name) => { const r = newRole("member", name, []); return roleOf((await ask("roles.create", { role: { id: r.id, label: r.name, base: "member", ...bodyOf(r) } }))?.role); },
    duplicate: async (/** @type {string} */ id) => {
      const src = roleOf((await ask("roles.get", { id }))?.role);
      const copy = duplicateRole(src, rolesOf(await ask("roles.list")));
      return roleOf((await ask("roles.create", { role: { id: copy.id, label: copy.name, base: copy.from === "admin" ? "admin" : "member", ...bodyOf(copy) } }))?.role);
    },
    save: async (/** @type {Role} */ role) => roleOf((await ask("roles.update", { id: role.id, role: { label: role.name, ...bodyOf(role) } }))?.role),
    remove: async (/** @type {string} */ id) => { await ask("roles.remove", { id }); },
  };
}

/** A role's settings as roles-core takes them: can and tools as lists of ids, data as a level per type, hidden fields apart. @param {Role} r */
export function bodyOf(r) {
  return {
    can: Object.entries(r.can).filter(([, v]) => v).map(([k]) => k),
    where: { kind: /** @type {any} */ (WHERE_OUT)[r.where.kind] ?? "my_projects", ...(r.where.kind === "chosen" ? { projects: r.where.projects } : {}) },
    data: Object.fromEntries(r.data.map((d) => [d.id, d.access])),
    hidden_fields: Object.fromEntries(r.data.filter((d) => d.hidden.length).map((d) => [d.id, d.hidden])),
    tools: Object.entries(r.tools).filter(([, v]) => v).map(([k]) => k),
  };
}

/** @param {any} d */
export function catalogueOf(d) {
  if (!d) return null;
  const can = (Array.isArray(d.can) ? d.can : []).filter((/** @type {any} */ c) => c && c.id).map((/** @type {any} */ c) => [String(c.id), String(c.label || c.id), String(c.gloss || "")]);
  const tools = (Array.isArray(d.tools) ? d.tools : []).filter((/** @type {any} */ t) => t && t.id).map((/** @type {any} */ t) => [String(t.id), String(t.label || t.id), ""]);
  return can.length || tools.length ? { can, tools } : null;
}

/** @param {any} d @returns {Role[]} */
export function rolesOf(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.roles) ? d.roles : [];
  return list.filter((/** @type {any} */ r) => r && typeof r.id === "string").map((/** @type {any} */ r) => roleOf(r));
}

/**
 * One role as roles-core states it (label, base, people, can and tools as id lists, data as a level per type, hidden_fields apart), tolerant of what it leaves out. A role with no `data`
 * has its can switches apply to every type, so each type is shown at the level its switches give. @param {any} r @param {{ id: string, name: string, fields: string[] }[]} [types] @returns {Role}
 */
export function roleOf(r, types = []) {
  r = r || {};
  const id = String(r.id ?? "");
  const ids = (/** @type {any} */ x) => Object.fromEntries((Array.isArray(x) ? x : []).map((/** @type {any} */ k) => [String(k), true]));
  const can = ids(r.can);
  const kind = /** @type {any} */ (WHERE_IN)[r.where?.kind] ?? "seats";
  const lv = r.data && typeof r.data === "object" ? r.data : null;
  const names = Object.fromEntries(types.map((t) => [t.id, t.name]));
  const keys = lv ? Object.keys(lv) : types.map((t) => t.id);
  const hidden = r.hidden_fields && typeof r.hidden_fields === "object" ? r.hidden_fields : {};
  return {
    id, name: String(r.label || r.name || id), builtin: r.builtin === true || ["owner", "admin", "member", "guest"].includes(id), from: r.base ? String(r.base) : "",
    holders: Number(r.people ?? r.holders) || 0, can, where: { kind, projects: Array.isArray(r.where?.projects) ? r.where.projects.map(String) : [] },
    data: keys.map((t) => ({ id: t, name: names[t] ?? t, access: lv ? (["none", "read", "edit"].includes(lv[t]) ? lv[t] : "none") : can.edit ? "edit" : can.view ? "read" : "none", hidden: Array.isArray(hidden[t]) ? hidden[t].map(String) : [] })),
    tools: ids(r.tools),
  };
}

/** @param {any} d */
export function typesOf(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.types) ? d.types : [];
  return list.filter((/** @type {any} */ t) => t && t.id != null).map((/** @type {any} */ t) => ({ id: String(t.id), name: String(t.plural || t.name || t.id), fields: (Array.isArray(t.fields) ? t.fields : []).map((/** @type {any} */ f) => String(f?.label || f?.name || f)) }));
}

/** @param {any} d */
export function projectsOf(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.projects) ? d.projects : [];
  return list.filter((/** @type {any} */ p) => p && p.id != null).map((/** @type {any} */ p) => ({ id: String(p.id), name: String(p.name || p.title || "A project") }));
}
