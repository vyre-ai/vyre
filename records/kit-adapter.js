// @ts-check
// The records language compiles a Kit to its own stored form (records/kits/<id>/kit.json). The kernel's Kit manager takes
// the shape in kernel/flows/kits.js: `{ format, id, version, name, includes: { types, templates, roles, teammates, flows, views } }`.
// This is the one place the two meet.

/** @param {any} kit the compiled Kit @returns {any} */
export function toKernelKit(kit) {
  const roles = kit.roles ?? [];
  // A view is stored with the type it shows (TypeDefinition.views), where the app reads it; the Kit's `views` list stays for the install card and removal.
  const views = kit.views ?? [];
  const types = (kit.types ?? []).map((/** @type {any} */ t) => {
    const mine = views.filter((/** @type {any} */ v) => v.of === t.name).map((/** @type {any} */ { of, ...v }) => v);
    return mine.length ? { ...t, views: mine } : t;
  });
  return {
    format: 1,
    id: kit.id,
    version: kit.version,
    name: kit.label ?? kit.id,
    description: kit.description ?? "",
    includes: {
      types,
      templates: (kit.templates ?? []).map((/** @type {any} */ t) => ({ ...t })),
      // a person role is built on one of the five roles; the Kit's own grants ride along as data for the install card
      roles: roles.filter((/** @type {any} */ r) => r.kind !== "teammate").map((/** @type {any} */ r) => ({ name: r.name, base: "member", abilities: ["projects.work_member_of"], label: r.label, description: r.description, grants: r.grants })),
      teammates: roles.filter((/** @type {any} */ r) => r.kind === "teammate").map((/** @type {any} */ r) => ({ name: r.name, label: r.label, description: r.description, instructions: r.instructions, grants: r.grants })),
      flows: kit.flows ?? [],
      views: kit.views ?? [],
    },
  };
}

/** Is this the compiled stored form (records/kits/<id>/kit.json) and not the kernel's? @param {any} kit */
export const isStoredKit = kit => Boolean(kit && typeof kit === "object" && kit.includes === undefined && Array.isArray(kit.types));

/** The kernel's form of a Kit given in either form. @param {any} kit */
export const kernelKit = kit => (isStoredKit(kit) ? toKernelKit(kit) : kit);

/**
 * What a Kit that ships with an ADDED module may be (a module adds data and screens, never people's powers): its id is the module's name, every record type is named for the module
 * (`<module>` or `<module>_x`, `<module>-x`) so it cannot redefine another Kit's or a core type, no type is a project type, and it carries no roles or teammates (their abilities are the
 * person's to give). Links to core types (a project, a contact) are free: that is how a module's items show on a project.
 * @param {string} module @param {any} kit the kernel's form @returns {string[]} the reasons it is refused, empty when it may be proposed
 */
export function moduleKitProblems(module, kit) {
  const out = [];
  const inc = (kit && kit.includes) || {};
  if (!kit || kit.id !== module) out.push(`the Kit's id is ${kit && kit.id}, and a module's Kit is named for the module (${module})`);
  const mine = (/** @type {string} */ n) => n === module || n.startsWith(`${module}_`) || n.startsWith(`${module}-`);
  for (const t of inc.types || []) {
    if (!mine(String(t.name))) out.push(`type ${t.name} is not named for the module: a module's types start with ${module}_`);
    if (t.kind === "project") out.push(`type ${t.name} is a project type; a module relates to projects with a link to project, it does not make one`);
  }
  for (const r of inc.roles || []) out.push(`role ${r.name}: a module's Kit adds no roles (a role is abilities, and abilities are the person's to give)`);
  for (const r of inc.teammates || []) out.push(`teammate ${r.name}: a module's Kit adds no teammates`);
  for (const t of inc.templates || []) if (!mine(String(t.name))) out.push(`template ${t.name} is not named for the module`);
  return out;
}
