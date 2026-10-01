// @ts-check
// scope: which projects' watchers a caller may see. The registry puts meta.reach on a call from an agent to a tool
// that declares a projectArg, from the projects module's own answer about that agent's grant; a person, a module
// and a hook have none and see everything. No answer means no projects (the registry fails closed with an empty list).

/**
 * @param {any} meta the call's meta
 * @param {string|null|undefined} project the project a watcher belongs to
 */
export function sees(meta, project) {
  const r = meta && meta.reach;
  if (!r) return true;
  if (r.all === true) return true;
  return typeof project === "string" && Array.isArray(r.projects) && r.projects.includes(project);
}
