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
