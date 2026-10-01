// @ts-check
// access — which folders a named agent may read through files.search/stat/preview/fetch, and
// which Taildrive shares files.drive may offer it (Vyre Drive step 5, federation). The user's
// own surfaces, modules and the person's own sessions see every configured root, unrestricted,
// exactly as before this existed. THE assistant rule (binding, 2026-09-28): the assistant walks
// every MAPPED project, same as a projects: "*" agent and NOT checked against projects.access
// (it is a different privilege tier, not subject to a per-agent revoke), but files are raw
// content, so it is never all:true either — unlike memory's personal facts, there is nothing
// "distilled" about a file. Any other named agent sees only its own granted projects' folders,
// intersected with projects.access, the same per-project door core/memory's reach() uses.
// Reviewer's MEDIUM 2 (450c34b6): all:true used to cover ANY unnamed caller, tailnet guests and
// unknown kinds included. Narrowed to the owner's own surfaces, modules, the person's own
// sessions and an owner device only; anything else reads as if it were a named agent with no
// projects at all, deny by default, rather than as the owner.
//
// The swap onto core/projects's projects.reach (35188a38 + 59d6833c): this module's own copy of
// the owner-vs-scoped decision above is correct and was reviewer-signed-off separately, but it is
// one of three copies (core/memory's own reach(), this one, and core/recall's later one) that had
// already drifted once before projects.reach existed to stop it happening again. What stays here:
// `within` and `agentOf` (still exported; other files in this module use them directly, and
// agentOf is how this file decides which agent's projects.reach is asking for its own).

import fs from "node:fs";

const AGENT_RE = /(?:^|[\s:])agent:(\(unnamed\)|[A-Za-z0-9_-]+)/;

/** Is folder `p` one of these folders, or under one? */
export function within(p, folders) {
  const c = String(p).replace(/\/+$/, "");
  return folders.some(f => { const base = String(f).replace(/\/+$/, ""); return c === base || c.startsWith(base + "/"); });
}

/** The agent name a caller string names ("mcp:agent:kit", "harness:agent:kit"), or null for the
 * user's own surfaces, a module, or a bare session. */
export const agentOf = caller => AGENT_RE.exec(String(caller || ""))?.[1] || null;

/**
 * Which folders `caller` may read. `{ all: true }` only for the true owner (its own surfaces, a
 * module, its own session, or an owner device): no restriction, exactly as this behaved before
 * this module existed. `{ all: false, agent, folders }` for everyone else, assistant included:
 * deny by default, so a project this box has never heard of, or one projects.access has
 * refused, is simply not in `folders`. A caller that names no agent and is not the owner either
 * (a tailnet guest, a hook, an unrecognised kind) reads with folders: [], the same as an agent
 * granted nothing.
 *
 * The owner-vs-scoped decision itself is core/projects's projects.reach (kind: "content": files
 * are raw, so the assistant is never all:true here either, matching this file's own rule above);
 * `caller` is forwarded verbatim (projects.reach needs the ORIGINAL caller, since ctx.call always
 * relabels the caller it sees "module:files").
 * @param {any} ctx @param {string} [caller]
 * @returns {Promise<{ all: boolean, agent: string|null, folders: string[] }>}
 */
export async function reach(ctx, caller) {
  const who = agentOf(caller);
  const r = await ctx.call("projects.reach", { ...(who ? { agent: who } : {}), caller, kind: "content" });
  if (r.error) {
    // An unnamed non-owner caller (a tailnet guest, a hook, an unrecognised kind) reads with no
    // projects at all, the same as an agent granted nothing, rather than as a throw: only a named
    // agent projects.reach could not find, or a real failure, is an actual refusal here.
    if (!who && r.error.code === "denied") return { all: false, agent: null, folders: [] };
    throw Object.assign(new Error(r.error.message), { code: r.error.code });
  }
  const { all, agent, projects } = r.data;
  return { all, agent, folders: all ? [] : (projects || []).flatMap(p => p.folders) };
}

/**
 * Is this path, followed through every link, inside one of the granted folders (also followed)?
 * `within` compares the text of a path, so a link inside a granted folder that points at another
 * project passes it; this is the check that stops that. A path that does not resolve is refused.
 * @param {string} p @param {string[]} folders
 */
export function withinReal(p, folders) {
  let r;
  try { r = fs.realpathSync(p); } catch { return false; }
  const real = folders.map(f => { try { return fs.realpathSync(f); } catch { return String(f); } });
  return within(r, real);
}
