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

import { ownerDevice } from "../modules/index.js";

const AGENT_RE = /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/;
/** The user's own surfaces, exactly as core/memory's reach() defines "owner" for this purpose. */
const OWNER = new Set(["deck", "cli", "local", "capsule"]);
/** A bare "mcp" is the user's own Claude Code session, and "mcp:thread:<id>" a session Vyre
 * runs for the user (ADR 0030); an agent's own says "mcp:agent:<name>", never bare. */
const ownSession = caller => /^mcp(?::thread:[A-Za-z0-9_-]+)?$/.test(String(caller || ""));
/** Whether an unnamed caller is the owner: its own surfaces, a module, its own session, or a
 * device signed in as the owner (tailnet or the relay). Anything else (a tailnet guest, a hook,
 * an unrecognised kind) is not, and reads with no projects at all rather than as the owner. */
const isOwner = caller => OWNER.has(String(caller)) || String(caller || "").startsWith("module:") || ownSession(caller) || ownerDevice(caller);

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
 * Which folders `caller` may read. `{ all: true }` only for the true owner (its own surfaces, a
 * module, its own session, or an owner device): no restriction, exactly as this behaved before
 * this module existed. `{ all: false, agent, folders }` for everyone else, assistant included:
 * deny by default, so a project this box has never heard of, or one projects.access has
 * refused, is simply not in `folders`. A caller that names no agent and is not the owner either
 * (a tailnet guest, a hook, an unrecognised kind) reads with folders: [], the same as an agent
 * granted nothing.
 * @param {any} ctx @param {string} [caller]
 * @returns {Promise<{ all: boolean, agent: string|null, folders: string[] }>}
 */
export async function reach(ctx, caller) {
  const who = agentOf(caller);
  if (!who) return isOwner(caller) ? { all: true, agent: null, folders: [] } : { all: false, agent: null, folders: [] };
  const r = await ctx.call("agents.list", {});
  if (r.error) throw denied(`agent ${who}: its projects cannot be checked (${r.error.code === "no_such_tool" ? "agents are not running on this machine" : r.error.message})`);
  const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
  const a = list.find(x => x && x.name === who);
  if (!a) throw denied(`no agent ${who}`);
  const pr = await ctx.call("projects.list", {});
  const projects = (pr.error ? [] : (Array.isArray(pr.data) ? pr.data : pr.data?.projects || []))
    .filter(p => p && p.slug)
    .map(p => ({ slug: String(p.slug), name: String(p.name || p.slug), folders: [...new Set([p.home, ...(p.workspaces || [])].filter(Boolean).map(String))] }));
  // THE assistant rule: every MAPPED project, unconditional, never checked against
  // projects.access (a different privilege tier, not the wildcard agent's own door below) —
  // but files are raw content, so still not all:true; there is nothing "distilled" about a file
  // the way there is about a personal fact.
  if (a.kind === "assistant") return { all: false, agent: who, folders: projects.flatMap(p => p.folders) };
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
