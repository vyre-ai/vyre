// @ts-check
// The Objects list: an icon for each kind of object (so two types never share initials), the line under a name, and the split between a person's own objects and the ones the product ships.

/** The icon of each type the product ships or a Space usually has; any other type gets the records icon. */
const ICONS = /** @type {Record<string, string>} */ ({
  contact: "contacts", organization: "space", deal: "budget", task: "task", event: "cal", communication: "chat", relationship: "link", note: "edit", reminder: "alarm",
  project: "projects", "project-template": "file", template: "file", playbook: "list", "team-member": "users", contact_point: "phone", skill: "spark", appointment: "cal", lead: "star", trip: "trip",
});
export const iconOfType = (/** @type {string} */ name) => ICONS[name] || "records";

/** Objects the product ships, listed apart from the person's own. */
export const BUILT_IN = new Set(["template", "playbook", "team-member", "project", "project-template", "skill", "contact_point"]);

/** The two lists of the Objects page: the person's own, then the built-in ones, each in the order given. @template {{ name: string }} T @param {T[]} types @returns {{ own: T[], builtIn: T[] }} */
export const splitTypes = (types) => ({ own: types.filter((t) => !BUILT_IN.has(t.name)), builtIn: types.filter((t) => BUILT_IN.has(t.name)) });

/** The one line under an object's name: "12 fields, 4 contacts. Links to Organizations and Contacts." @param {{ fields: number, records: number, label: string, plural: string, links: { to: string, label: string, many: boolean }[] }} t @param {(name: string) => string} labelOf */
export function subLine(t, labelOf) {
  const base = `${t.fields} ${t.fields === 1 ? "field" : "fields"}, ${t.records} ${t.records === 1 ? t.label.toLowerCase() : t.plural.toLowerCase()}`;
  const to = [...new Set(t.links.map((l) => labelOf(l.to)))];
  if (!to.length) return base;
  const list = to.length === 1 ? to[0] : `${to.slice(0, -1).join(", ")} and ${to[to.length - 1]}`;
  return `${base}. Links to ${list}.`;
}
