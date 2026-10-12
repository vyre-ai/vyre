// @ts-check
// Roles over the box (the roles.* tools, answered by roles-core) or, in the sample world, over a small store in memory. One shape for both:
// read() gives the roles, the record types the data section lists and the projects "chosen projects" picks from; the writes answer the stored role.
import { SAMPLE_TYPES, duplicateRole, newRole, removeRefusal, nameProblem, screenRole, wireRole, withTypes } from "./model.js";
import { MOCK_PROJECTS, sampleRoles } from "./mock.js";

/** @typedef {import("./model.js").Role} Role */
/** @typedef {{ roles: Role[], types: { id: string, name: string, fields: string[] }[], projects: { id: string, name: string }[] }} World */

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

/**
 * The real source over `call` (the app's box connection, or a fake box in a test). The tool names and shapes are roles-core's; the mapper below is
 * the one place that knows them.
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
      const [list, types, projects] = await Promise.all([ask("roles.list"), ask("records.types.list").catch(() => null), ask("work.projects.list").catch(() => null)]);
      const ts = typesOf(types);
      return /** @type {World} */ ({ roles: rolesOf(list).map((r) => withTypes(r, ts.length ? ts : SAMPLE_TYPES)), types: ts.length ? ts : SAMPLE_TYPES, projects: projectsOf(projects) });
    },
    create: async (/** @type {string} */ from, /** @type {string} */ name) => roleOf(await ask("roles.create", { name: name.trim(), from: wireRole(from) })),
    duplicate: async (/** @type {string} */ id) => roleOf(await ask("roles.duplicate", { id })),
    save: async (/** @type {Role} */ role) => roleOf(await ask("roles.update", { id: role.id, name: role.name, can: role.can, where: role.where, data: role.data, tools: role.tools })),
    remove: async (/** @type {string} */ id) => { await ask("roles.remove", { id }); },
  };
}

/** @param {any} d @returns {Role[]} */
export function rolesOf(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.roles) ? d.roles : [];
  return list.filter((/** @type {any} */ r) => r && typeof r.id === "string").map(roleOf);
}

/** One role as the box states it, tolerant of what it leaves out. @param {any} r @returns {Role} */
export function roleOf(r) {
  const id = screenRole(String(r.id));
  const bool = (/** @type {any} */ o) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).map(([k, v]) => [k, v === true]));
  const kind = ["space", "seats", "chosen", "own"].includes(r.where?.kind) ? r.where.kind : "seats";
  return {
    id, name: String(r.name || id), builtin: r.builtin === true || ["owner", "admin", "member", "guest"].includes(id), from: r.from ? screenRole(String(r.from)) : "",
    holders: Number(r.holders ?? r.count) || 0, can: bool(r.can), where: { kind, projects: Array.isArray(r.where?.projects) ? r.where.projects.map(String) : [] },
    data: (Array.isArray(r.data) ? r.data : []).filter((/** @type {any} */ d) => d && d.id != null).map((/** @type {any} */ d) => ({ id: String(d.id), name: String(d.name || d.id), access: ["none", "read", "edit"].includes(d.access) ? d.access : "none", hidden: Array.isArray(d.hidden) ? d.hidden.map(String) : [] })),
    tools: bool(r.tools),
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
