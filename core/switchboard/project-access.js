// @ts-check
// Which project folders a session may touch on a team server (team/0.3.4/PROJECT-GROUPS.md). A member's session runs as her own account uid; the spawner gives it the group of each project it names and no
// other, so the kernel keeps one project's folder from another's session. This file decides the list. It comes from the ACCOUNT the session runs on and the work module's seat rule
// (work.project.seat: owner or team), never from a label the caller sent. No resolvable person is no project: never all of them.

import path from "node:path";
import { projectGroup, usesSpawner } from "../sessions/spawn.js";
import { mappedProjects as mapped, syncAll, workRoot, under } from "../../lib/project-folders.js";

/** The spawner takes at most this many project ids in one spawn (core/spawner/project-groups.js MAX_PER_SPAWN). */
const MAX_PER_SPAWN = 64;
/** A first launch for a project that takes longer than this says what it is doing (the folder is being handed to its group). */
const SAY_AFTER_MS = 3000;

const mappedProjects = (/** @type {any} */ sb) => mapped(() => sb.deps.call("projects.list", {}));

/**
 * The project ids a session on an ACCOUNT may join. The person is the account's (an account with no person is the home's own: the owner's, who reaches every project). Anyone else gets exactly the projects
 * whose seat (work.project.seat) says owner or team. An agent's turn on that account gets the intersection with the agent's own grant (`scope.projects`: "*" or a list); an agent with no grant gets none.
 * No person that can be resolved: none. The session's own project comes first, so a person on more projects than one spawn can carry still gets the one she is working in.
 * @param {any} sb @param {{ person?: string | null }} run the account the session runs on @param {{ agent?: string | null, scope?: { projects: string[] | "*" } | null, cwd?: string }} [want]
 * @returns {Promise<string[]>}
 */
export async function projectsFor(sb, run, want = {}) {
  const owner = typeof sb.deps.owner === "function" ? sb.deps.owner() : null;
  const person = run && run.person ? String(run.person) : owner ? String(owner) : "";
  if (!person) return [];
  const mapped = await mappedProjects(sb);
  const isOwner = Boolean(owner) && sb.canon(person) === sb.canon(String(owner));
  /** @type {string[]} */ let mine;
  if (isOwner) mine = mapped.map(p => p.slug);
  else {
    const seats = await Promise.all(mapped.map(async p => {
      const r = /** @type {any} */ (await sb.deps.call("work.project.seat", { project: p.slug, person }).catch(() => null));
      const s = r && !r.error ? r.data : null;
      return Boolean(s && s.exists && (s.owner || s.team));
    }));
    mine = mapped.filter((_p, i) => seats[i]).map(p => p.slug);
  }
  if (want.agent) {
    const grant = want.scope && want.scope.projects;
    mine = grant === "*" ? mine : Array.isArray(grant) ? mine.filter(s => grant.includes(s)) : [];
  }
  // the project the session works in first
  const cwd = want.cwd ? path.resolve(want.cwd) : "";
  const here = cwd ? mapped.find(p => p.folders.some(f => under(cwd, f))) : null;
  if (here && mine.includes(here.slug)) mine = [here.slug, ...mine.filter(s => s !== here.slug)];
  if (mine.length > MAX_PER_SPAWN) { sb.deps.log(`threads: ${person} is on ${mine.length} projects; a session joins the first ${MAX_PER_SPAWN}, the one it works in first`); mine = mine.slice(0, MAX_PER_SPAWN); }
  return mine;
}

/**
 * The first launch in a project's folder hands it to the project's group (the spawner's project-group op; idempotent, so a folder already done costs one short call). Everything that can reach the spawner under
 * /work asks, a session of an account or of the box agent alike. A launch that waits says what it is doing; one that cannot be done is refused with the reason.
 * @param {any} sb @param {string} cwd @param {(text: string) => void} [say] @param {{ ask?: typeof projectGroup }} [o]
 * @returns {Promise<string | null>} the project's slug that was ensured, or null when the folder is not in a mapped project
 */
export async function ensureFolder(sb, cwd, say, o = {}) {
  const dir = cwd ? path.resolve(cwd) : "";
  if (!dir || !under(dir, workRoot())) return null;
  const here = (await mappedProjects(sb)).find(p => p.folders.some(f => under(dir, f)));
  if (!here) return null;
  const ask = o.ask || projectGroup;
  const timer = say ? setTimeout(() => say("Setting up this project's folder access, once. The first start in a project can take a moment."), SAY_AFTER_MS) : null;
  try {
    for (const f of here.folders) await ask(here.slug, f);
  } catch (e) {
    throw Object.assign(new Error(`Vyre did not start this session: the project folder could not be set up for it (${String(/** @type {Error} */ (e).message || e).slice(0, 240)}). Check the folder is owned by Vyre and is inside ${workRoot()}, then start again.`), { code: "sandbox_failed" });
  } finally { if (timer) clearTimeout(timer); }
  return here.slug;
}

/**
 * A seat was removed (or any team change): every running session on a person's own account is judged again against the seat rule, and one that is under a project the person no longer has a seat on is stopped.
 * Groups are fixed when a process starts, so the stop is what takes the seat away from a session already running. The folder it was started in decides which project it is "under".
 * @param {any} sb @param {{ stop: (id: string, why: string) => Promise<unknown> | unknown }} [o]
 * @returns {Promise<string[]>} the threads stopped
 */
export async function stopLostSeats(sb, o = { stop: async (id, why) => { const rec = sb.record(id); sb.emit("thread.text", { message: "vyre", text: `${why}, so this session was stopped. Ask the project's owner to add you back, then start it again.`, done: true, notice: true }, id, rec ? rec.project : null); await sb.stop(id); } }) {
  /** @type {string[]} */ const stopped = [];
  const owner = typeof sb.deps.owner === "function" ? sb.deps.owner() : null;
  for (const [id, st] of sb.live) {
    const run = st && st.launch && st.launch.accountRun;
    if (!run || run.uid == null || !run.person) continue;
    if (owner && sb.canon(String(run.person)) === sb.canon(String(owner))) continue;
    const rec = sb.record(id);
    const cwd = rec && rec.cwd;
    if (!cwd) continue;
    const here = (await mappedProjects(sb)).find(p => p.folders.some(f => under(path.resolve(String(cwd)), f)));
    if (!here) continue;
    const r = /** @type {any} */ (await sb.deps.call("work.project.seat", { project: here.slug, person: String(run.person) }).catch(() => null));
    const s = r && !r.error ? r.data : null;
    if (r && !r.error && !(s && s.exists && (s.owner || s.team))) { await o.stop(id, `${run.person} is no longer on the project ${here.slug}`); stopped.push(id); }
  }
  return stopped;
}

/** The group a session's socket is given: an account's session, its account's group (gid equals uid); the box agent's, the agent's own. @param {{ uid?: number | null } | null | undefined} run */
export function socketGid(run) {
  if (run && run.uid != null) return Number(run.uid);
  const g = Number(process.env.VYRE_AGENT_GID);
  return Number.isInteger(g) && g > 0 ? g : 1001;
}

/**
 * The launch step: the folder the session starts in is handed to its project's group, and a session on an account gets the project ids it joins in `accountRun.projects`. Returns the launch options.
 * @param {any} sb @param {any} rec @param {any} o @param {string} id
 */
export async function launchAccess(sb, rec, o, id) {
  await ensureFolder(sb, rec.cwd, text => sb.emit("thread.text", { message: "vyre", text, done: true, notice: true }, id, rec.project));
  if (!(o.accountRun && o.accountRun.uid != null)) return o;
  return { ...o, accountRun: { ...o.accountRun, projects: await projectsFor(sb, o.accountRun, { agent: o.agent || rec.agent || null, scope: o.scope || null, cwd: rec.cwd }) } };
}

/** projects.sync, from the projects module: every mapped project's folders handed to their groups. Refused with a next step where there is no spawner. @param {any} sb */
export async function syncProjects(sb) {
  if (!usesSpawner()) throw Object.assign(new Error("this computer has no project groups (sessions do not run through the spawner here), so there is nothing to do; run it on the team server's box"), { code: "unavailable" });
  return syncAll(() => sb.deps.call("projects.list", {}), projectGroup);
}

/** A socket kept across a respawn or a hop is given the group of the account the session runs on now. @param {any} have the stored socket @param {{ uid?: number | null } | null} run @param {(m: string) => void} log */
export function regroupSocket(have, run, log) {
  const want = socketGid(run);
  if (!have || have.gid === want || typeof have.setGroup !== "function") return;
  try { have.setGroup(want); have.gid = want; } catch (e) { log(`threads: a session's socket could not be given its account's group (${/** @type {Error} */ (e).message})`); }
}

/**
 * The tools and the one listener of this part, for the Switchboard module: a seat on a project was taken away (the work module hears the team change and asks threads.seats.recheck), and projects.sync's work (the projects module asks
 * threads.projects.sync). Both are for modules only.
 * @param {any} ctx @param {any} sb @returns {() => void} stop listening
 */
export function accessTools(ctx, sb) {
  const none = { type: "object", properties: {} };
  ctx.tool("threads.seats.recheck", { description: "Judge every running session on a person's own account again against the project seat rule and stop the ones under a project that person is no longer on. For the work module, on a team change.", internal: true, input: none, run: async () => ({ stopped: await stopLostSeats(sb) }) });
  ctx.tool("threads.projects.sync", { description: "Give every project's folder under /work to the project's own group (projects.sync, the owner's call, is the way in). For the projects module.", internal: true, input: none, run: async () => syncProjects(sb) });
  return watchProjectFolders(ctx, sb);
}

/**
 * A project made (or given a folder) on a team server is handed to its own group at once, not at its first launch: a folder made by vyred is born readable to its group and, until then, to anyone who knows the path.
 * @param {any} ctx @param {any} sb @returns {() => void} stop listening
 */
function watchProjectFolders(ctx, sb) {
  return ctx.events.on("project.created", (/** @type {any} */ e) => {
    const p = (e && e.payload) || {};
    if (usesSpawner() && typeof p.home === "string") void ensureFolder(sb, p.home).catch((/** @type {Error} */ err) => ctx.log(`threads: project ${String(p.project || "").slice(0, 60)} could not be handed to its group yet (${err.message}); its first launch asks again`));
  });
}
