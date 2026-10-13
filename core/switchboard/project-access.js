// @ts-check
// Which project folders a session may touch on a team server (team/0.3.4/PROJECT-GROUPS.md). A member's session runs as her own account uid; the spawner gives it the group of each project it names and no
// other, so the kernel keeps one project's folder from another's session. This file decides the list. It comes from the ACCOUNT the session runs on and the work module's seat rule
// (work.project.seat: owner or team), never from a label the caller sent. No resolvable person is no project: never all of them.

import path from "node:path";
import { projectGroup, usesSpawner } from "../sessions/spawn.js";
import { mappedProjects as mapped, syncAll, workRoot, under } from "../../lib/project-folders.js";
import { VIEWER_WORDS } from "../../lib/seat-levels.js";

/** The spawner takes at most this many project ids in one spawn (core/spawner/project-groups.js MAX_PER_SPAWN). */
const MAX_PER_SPAWN = 64;
/** A first launch for a project that takes longer than this says what it is doing (the folder is being handed to its group). */
const SAY_AFTER_MS = 3000;

const mappedProjects = (/** @type {any} */ sb) => mapped(() => sb.deps.call("projects.list", {}));
/** Where a person stands on a project (work.project.seat): { exists, owner, team, level } or null. @param {any} sb @param {string} slug @param {string} person */
const seatOn = async (sb, slug, person) => { const r = /** @type {any} */ (await sb.deps.call("work.project.seat", { project: slug, person }).catch(() => null)); return r && !r.error ? r.data : null; };

/**
 * The person a session on an account is for. The account's own person; or, for an account that records none (the home's legacy accounts), the launch's VERIFIED person (a chat turn's asker) when that
 * person is the home's owner. Nothing else is a person: an account with no person and no verified owner behind the launch is nobody's, and gets no project (never the owner's reach by default, so a
 * member's account row that lost its person gets nothing). @param {any} sb @param {{ person?: string | null }} run @param {{ person?: string | null }} [want]
 * @returns {{ person: string, owner: boolean } | null}
 */
export function personOf(sb, run, want = {}) {
  const owner = typeof sb.deps.owner === "function" ? sb.deps.owner() : null;
  const isOwner = (/** @type {string} */ p) => Boolean(owner) && sb.canon(p) === sb.canon(String(owner));
  if (run && run.person) return { person: String(run.person), owner: isOwner(String(run.person)) };
  if (want.person && isOwner(String(want.person))) return { person: String(want.person), owner: true };
  return null;
}

/**
 * The project ids a session on an ACCOUNT may join: the person's (personOf), by the seat rule (work.project.seat: owner or team); the home's owner reaches every project under /work. An agent's turn on that
 * account gets the intersection with the agent's own grant (`scope.projects`: "*" or a list); an agent with no grant gets none. No resolvable person: none. The session's own project comes first, so a
 * person on more projects than one spawn can carry still gets the one she is working in; `all` skips that cap (the seat recheck compares whole lists).
 * @param {any} sb @param {{ person?: string | null }} run the account the session runs on @param {{ agent?: string | null, scope?: { projects: string[] | "*" } | null, cwd?: string, person?: string | null, all?: boolean }} [want]
 * @returns {Promise<string[]>}
 */
export async function projectsFor(sb, run, want = {}) {
  const who = personOf(sb, run, want);
  if (!who) return [];
  const person = who.person;
  const mapped = await mappedProjects(sb);
  /** @type {string[]} */ let mine;
  if (who.owner) mine = mapped.map(p => p.slug);
  else {
    // A VIEWER's session gets no project group: the folder is one read-and-write group, so a read-only seat is left out of it, and the project's files reach a viewer's assistant only through Vyre's own read
    // (the kernel refuses its writes, kernel/core/folders.js). The seat's level comes with the seat (work.project.seat).
    const seats = await Promise.all(mapped.map(async p => {
      const s = await seatOn(sb, p.slug, person);
      return Boolean(s && s.exists && (s.owner || s.team) && (s.level === "lead" || s.level === "contributor"));   // a missing or unknown level is no group, never read-write
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
  if (!want.all && mine.length > MAX_PER_SPAWN) { sb.deps.log(`threads: ${person} is on ${mine.length} projects; a session joins the first ${MAX_PER_SPAWN}, the one it works in first`); mine = mine.slice(0, MAX_PER_SPAWN); }
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
 * A seat was removed (or any team change): every running session on a person's own account is judged again. A session joined the group of EVERY project its person was on when it started
 * (`accountRun.projects`), and a process keeps its groups, so one that has lost a seat on ANY of them, whatever folder it works in, is stopped; one that still has every seat is left alone.
 * @param {any} sb @param {{ stop: (id: string, why: string) => Promise<unknown> | unknown }} [o]
 * @returns {Promise<string[]>} the threads stopped
 */
export async function stopLostSeats(sb, o = { stop: async (id, why) => { const rec = sb.record(id); sb.emit("thread.text", { message: "vyre", text: `${why}, so this session was stopped. Ask the project's owner to add you back, then start it again.`, done: true, notice: true }, id, rec ? rec.project : null); await sb.stop(id); } }) {
  /** @type {string[]} */ const stopped = [];
  for (const [id, st] of [...sb.live]) {
    const l = st && st.launch, run = l && l.accountRun;
    if (!run || run.uid == null || !run.person || !Array.isArray(run.projects) || !run.projects.length) continue;
    const rec = sb.record(id);
    const now = await projectsFor(sb, run, { agent: l.agent || (rec && rec.agent) || null, scope: l.scope || null, cwd: rec && rec.cwd, all: true });
    // only a project that still exists on this box and that she has no seat on now: a project deleted or unmapped since the launch is not a lost seat (it must not stop the owner's session)
    const there = new Set((await mappedProjects(sb)).map(p => p.slug));
    const lost = run.projects.filter((/** @type {string} */ p) => there.has(p) && !now.includes(p));
    if (lost.length) { await o.stop(id, `${run.person} is no longer on ${lost.length === 1 ? "the project" : "the projects"} ${lost.join(", ")}`); stopped.push(id); }
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
  const say = (/** @type {string} */ text) => sb.emit("thread.text", { message: "vyre", text, done: true, notice: true }, id, rec.project);
  const account = Boolean(o.accountRun && o.accountRun.uid != null);
  const want = { agent: o.agent || rec.agent || null, scope: o.scope || null, cwd: rec.cwd, person: (o.kernelTurn && o.kernelTurn.asker) || null };   // the verified chat turn's asker, never a caller's word
  const who = account ? personOf(sb, o.accountRun, want) : null;
  // a viewer's session in the project's own folder is not started: the folder is one read-and-write group and is not theirs to write
  if (who && !who.owner && rec.cwd) {
    const dir = path.resolve(rec.cwd), here = (await mappedProjects(sb)).find(p => p.folders.some(f => under(dir, f)));
    const seat = here ? await seatOn(sb, here.slug, who.person) : null;
    if (here && seat && seat.level === "viewer") throw Object.assign(new Error(`Vyre did not start this session in ${here.slug}: ${VIEWER_WORDS} Ask the project lead to change your level, from the Team tab of the project.`), { code: "not_allowed" });
  }
  await ensureFolder(sb, rec.cwd, say);
  if (!account) return o;
  if (!who) say("This AI account has no person recorded, so this session gets no project folders. Open AI accounts and sign in with your own account again, or ask the owner to check it.");
  return { ...o, accountRun: { ...o.accountRun, projects: await projectsFor(sb, o.accountRun, want) } };
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
