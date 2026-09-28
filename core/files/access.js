// @ts-check
// access — which folders a named agent may read through files.search/stat/preview/fetch, and
// which Taildrive shares files.drive may offer it (Vyre Drive step 5, federation). The user's
// own surfaces, modules and the assistant see every configured root, unrestricted, exactly as
// before this existed. Any other named agent sees only its own granted projects' folders,
// intersected with projects.access (core/projects) the same per-project door core/memory's
// reach() uses for the graph and Recall's own copy uses for search: kept as this module's own
// copy rather than a shared lib, since files, memory and Recall are separate module boundaries
// (core/modules' boundary test) and this isn't pure/stateless enough yet to hoist out without a
// bigger refactor than this step calls for.

const AGENT_RE = /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/;

/** Is folder `p` one of these folders, or under one? */
export function within(p, folders) {
  const c = String(p).replace(/\/+$/, "");
  return folders.some(f => { const base = String(f).replace(/\/+$/, ""); return c === base || c.startsWith(base + "/"); });
}

/** The agent name a caller string names ("mcp:agent:kit", "harness:agent:kit"), or null for the
 * user's own surfaces, a module, or a bare session. */
export const agentOf = caller => AGENT_RE.exec(String(caller || ""))?.[1] || null;

const denied = message => Object.assign(new Error(message), { code: "denied" });

/**
 * Which folders `caller` may read. `{ all: true }` for the user's own surfaces, a module, or the
 * assistant: no restriction, the caller of this function should behave exactly as it did before
 * this module existed. `{ all: false, agent, folders }` for any other named agent: deny by
 * default, so a project this box has never heard of, or one projects.access has refused, is
 * simply not in `folders`.
 * @param {any} ctx @param {string} [caller]
 * @returns {Promise<{ all: boolean, agent: string|null, folders: string[] }>}
 */
export async function reach(ctx, caller) {
  const who = agentOf(caller);
  if (!who) return { all: true, agent: null, folders: [] };
  const r = await ctx.call("agents.list", {});
  if (r.error) throw denied(`agent ${who}: its projects cannot be checked (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`);
  const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
  const a = list.find(x => x && x.name === who);
  if (!a) throw denied(`no agent ${who}`);
  if (a.kind === "assistant") return { all: true, agent: who, folders: [] };
  const pr = await ctx.call("projects.list", {});
  const projects = (pr.error ? [] : (Array.isArray(pr.data) ? pr.data : pr.data?.projects || []))
    .filter(p => p && p.slug)
    .map(p => ({ slug: String(p.slug), name: String(p.name || p.slug), folders: [...new Set([p.home, ...(p.workspaces || [])].filter(Boolean).map(String))] }));
  const mine = new Set(Array.isArray(a.projects) ? a.projects.map(String) : []);
  const granted = a.projects === "*" ? projects : projects.filter(p => mine.has(p.slug) || mine.has(p.name));
  // Mirrors core/memory/index.js's reach() (Vyre Drive step 3): agents.projects alone is not the
  // only door. Where projects.access is not running at all (no_such_tool), nothing changes: an
  // install without it keeps agents.projects' own scope as today.
  const checked = await Promise.all(granted.map(async p => {
    const c = await ctx.call("projects.access.check", { project: p.slug, agent: who });
    if (c.error && c.error.code === "no_such_tool") return p;
    return c.data && c.data.granted ? p : null;
  }));
  const allowed = checked.filter(Boolean);
  return { all: false, agent: who, folders: allowed.flatMap(p => p.folders) };
}
