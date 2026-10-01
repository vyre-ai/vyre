// @ts-check
// scope: which projects' watchers a caller may see.
//   an agent with a stored grant: the registry puts meta.reach on its call to a tool that declares a
//     projectArg (from the projects module's answer); no answer means no projects (fail closed).
//   a plain model session (the person's own Claude Code through Vyre's MCP, no verified thread or agent):
//     vyred reads who and where it is from the socket peer and sets meta.peerSession and meta.peerCwd
//     (null where the OS will not say). It sees its folder's project's watchers, as sessions narrows its
//     thread reads, and nothing where the folder is unknown or in no project.
//   a Vyre thread session (a chat session vyred verified: meta.thread, no stored-grant agent): its own thread's
//     project (threads.get), as sessions' sessionMay does; nothing if the thread has no project or the lookup fails.
//   a person, a module and a hook (and a session on a build that does not set the peer): everything.

/**
 * @param {any} meta the call's meta
 * @param {(cwd: string) => Promise<string|null>} projectOfCwd the project that owns a folder, or null
 * @param {(thread: string) => Promise<string|null>} [projectOfThread] the project a thread belongs to, or null
 * @returns {Promise<(project: string|null|undefined) => boolean>}
 */
export async function scopeFor(meta, projectOfCwd, projectOfThread = async () => null) {
  const r = meta && meta.reach;
  if (r) {
    if (r.all === true) return () => true;
    const granted = Array.isArray(r.projects) ? r.projects : [];
    return project => typeof project === "string" && granted.includes(project);
  }
  // A verified thread session: its own thread's project, and nothing when it has none or cannot be looked up.
  if (meta && typeof meta.thread === "string" && meta.thread) {
    const mine = await projectOfThread(meta.thread).catch(() => null);
    return project => Boolean(mine && project === mine);
  }
  // Set by vyred for a plain model caller only, over anything a client sent (the keys exist, possibly null).
  if (meta && ("peerSession" in meta || "peerCwd" in meta)) {
    const cwd = typeof meta.peerCwd === "string" && meta.peerCwd ? meta.peerCwd : null;
    const mine = cwd ? await projectOfCwd(cwd).catch(() => null) : null;
    return project => Boolean(mine && project === mine);
  }
  return () => true;
}

/** Kept for callers that only have the agent rule: a person, a module and a hook see all. */
export function sees(meta, project) {
  const r = meta && meta.reach;
  if (!r) return true;
  if (r.all === true) return true;
  return typeof project === "string" && Array.isArray(r.projects) && r.projects.includes(project);
}
