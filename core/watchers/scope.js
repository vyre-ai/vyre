// @ts-check
// scope: which projects' watchers a caller may see. The registry puts meta.reach on a call from an agent to a tool
// that declares a projectArg, from the projects module's own answer about that agent's grant; a person, a module
// and a hook have none and see everything. No answer means no projects (the registry fails closed with an empty list).

//
// Decided, and open for 0.2.5: a plain model session (mcp, mcp:thread: the person's own Claude Code
// session, not an agent with a stored grant) has no meta.reach and sees every project's watchers, the
// way it sees every project in projects.list. Sessions narrows a plain thread's reads of transcripts to its
// folder's project (peerCwd) because a transcript carries what was said in other contexts; a watcher's card
// and logs carry what the person asked to watch and what was filed, and narrowing here would need the
// session's folder, which the registry does not pass to a tool today. With Spaces, when a project is shared
// with people other than its owner, a plain session must be scoped too: revisit then (team/0.2.5/spaces/watchers.md).

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
