// @ts-check
// A fake projects.reach (core/projects/index.js, 35188a38 + 59d6833c) for every test that needs
// one, in the two harness shapes core/files and core/memory's own tests use:
//   - a hand-built fake ctx.call (core/memory/access.test.js, scope.test.js): use fakeReachCall.
//   - a real Registry with fake "agents"/"projects" modules (core/files/files.test.js,
//     drive.test.js): use installFakeReach.
// One piece of logic (reachLogic) backs both, so they can't drift from each other or from the
// real tool's owner-case handling. Needed because core/files/access.js and core/memory/index.js's
// own reach() now ask projects.reach even to decide who the OWNER is (not just agent scoping):
// without an install here, a plain "cli"/"deck" caller in a test that never mentioned an agent
// would be refused too, since a missing projects.reach reads as denied-by-default, not as
// "nothing to check".
import { writeModule } from "../helpers.js";
import { fileURLToPath, pathToFileURL } from "node:url";

const OWNER = new Set(["deck", "cli", "local", "capsule"]);
/** Mirrors core/modules/index.js's ownerDevice (a paired device) without importing it: this logic is also written out to its own module file on
 * disk, so it stays self-contained rather than depending on a relative path back into core/. */
const isOwner = c => OWNER.has(String(c)) || String(c || "").startsWith("module:")
  || /^mcp(?::thread:[A-Za-z0-9_-]+)?$/.test(String(c || ""))
  || /^device:[a-z2-7]{16}$/.test(String(c || ""));
const agentNamed = c => /(?:^|[\s:])agent:([A-Za-z0-9_-]+)/.exec(String(c || ""))?.[1] || null;
const denied = message => Object.assign(new Error(message), { code: "denied" });

/**
 * The real tool's owner-vs-scoped decision (core/projects/index.js's projects.reach), against a
 * plain in-memory fixture instead of live agents/projects modules. Throws `denied` exactly where
 * the real tool does.
 *
 * `access` left out entirely (as opposed to `{}`) simulates projects.access not being installed
 * at all: every candidate project is granted, agents.projects' own scope unchanged, mirroring the
 * real tool's own `no_such_tool` fallback on projects.access.check. `access: {}` (or any object)
 * simulates the module being present: deny by default, only a listed "<slug>:<agent>" pair grants.
 * @param {{ agents?: any[], projects?: any[], access?: Record<string, boolean> }} fixture
 * @param {{ agent?: string, caller?: string, kind?: "facts"|"content" }} input
 */
export function reachLogic({ agents = [], projects = [], access } = {}, { agent, caller, kind = "content" } = {}) {
  const said = agentNamed(caller);
  if (said && agent && said !== agent) throw denied(`the call came from agent ${said} but names agent ${agent}`);
  const who = said || agent || null;
  if (!who) {
    if (isOwner(caller)) return { all: true, agent: null };
    throw denied(`refused for ${String(caller || "an unnamed caller").slice(0, 60)}`);
  }
  const a = agents.find(x => x && x.name === who);
  if (!a) throw denied(`no agent ${who}`);
  const all = projects.map(p => ({
    slug: p.slug, name: p.name || p.slug,
    folders: p.workspaces ? [p.home, ...p.workspaces].filter(Boolean) : [p.home].filter(Boolean),
    threads: p.picks || [],
  }));
  const assistant = a.kind === "assistant";
  if (assistant && kind === "facts") return { all: true, agent: who };
  if (assistant) return { all: false, agent: who, projects: all };
  const wildcard = a.projects === "*";
  const mine = new Set(Array.isArray(a.projects) ? a.projects.map(String) : []);
  const candidate = wildcard ? all : all.filter(p => mine.has(p.slug) || mine.has(p.name));
  const granted = access === undefined ? candidate : candidate.filter(p => Boolean(access[`${p.slug}:${who}`]));
  return { all: false, agent: who, projects: granted };
}

/**
 * Answers agents.list / projects.list / projects.access.check / projects.reach the shape
 * `{ data } | { error }` a ctx.call itself returns — for a hand-built fake ctx.call (memory's own
 * test style), which never goes through core/modules/index.js's Registry.run() to get that
 * conversion for free.
 * @param {string} tool @param {any} input
 * @param {{ agents?: any[], projects?: any[], access?: Record<string, boolean> }} fixture
 */
export async function fakeReachCall(tool, input, fixture) {
  const { agents = [], projects = [], access } = fixture || {};
  if (tool === "agents.list") return { data: agents };
  if (tool === "projects.list") return { data: { projects } };
  if (tool === "projects.access.check") {
    // access left out entirely: no projects.access module in this test's world (memory's own
    // reach() falls back to agents.projects' own scope, unchanged); access: {} or a map: present,
    // deny by default.
    if (access === undefined) return { error: { code: "no_such_tool", message: tool } };
    return { data: { project: input?.project, agent: input?.agent, granted: Boolean(access[`${input?.project}:${input?.agent}`]) } };
  }
  if (tool === "projects.reach") {
    try { return { data: reachLogic({ agents, projects, access }, input) }; }
    catch (e) { return { error: { code: /** @type {any} */ (e).code || "failed", message: /** @type {Error} */ (e).message } }; }
  }
  return { error: { code: "no_such_tool", message: tool } };
}

const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * Installs a Registry-loadable "agents" module (agents.list) and "projects" module
 * (projects.list, projects.access.check, projects.reach) into `mods` (a temp folder `discover`
 * will read modules back from), always answering from `fixture` (default: empty, so an owner
 * caller still reaches as the owner with nothing granted) — for core/files/files.test.js and
 * drive.test.js's own registry() helpers. Call this unconditionally, whether or not a test cares
 * about agent scoping: see the file header for why a missing projects.reach breaks every other
 * caller too, now that files' reach() asks it even for the owner case.
 * @param {string} mods
 * @param {string} root  the test's VYRE_HOME (ctx.paths.root); the fixture map's key
 * @param {{ agents?: any[], projects?: any[], access?: Record<string, boolean> }} [fixture]
 */
export function installFakeReach(mods, root, fixture = {}) {
  globalThis.__fakeReach = globalThis.__fakeReach || new Map();
  globalThis.__fakeReach.set(root, fixture);
  const reachModule = JSON.stringify(pathToFileURL(THIS_FILE).href);
  writeModule(mods, "agents", { roles: ["local", "box"], does: { tools: [{ name: "agents.list", reach: "modules" }] } },
    `export default { async start(ctx) {
      ctx.tool("agents.list", { input: { type: "object", properties: {} },
        run: async () => (globalThis.__fakeReach.get(ctx.paths.root) || {}).agents || [] });
      return { async stop() {} };
    } };`);
  writeModule(mods, "projects", { roles: ["local", "box"], does: { tools: [{ name: "projects.list", reach: "modules" }, { name: "projects.access.check", reach: "modules" }, { name: "projects.reach", reach: "modules" }] } },
    `import { reachLogic } from ${reachModule};
    export default { async start(ctx) {
      const fx = () => globalThis.__fakeReach.get(ctx.paths.root) || {};
      ctx.tool("projects.list", { input: { type: "object", properties: {} }, run: async () => ({ projects: fx().projects || [] }) });
      ctx.tool("projects.access.check", {
        input: { type: "object", required: ["project", "agent"], properties: { project: { type: "string" }, agent: { type: "string" } } },
        run: async ({ project, agent }) => ({ project, agent, granted: Boolean((fx().access || {})[project + ":" + agent]) }),
      });
      ctx.tool("projects.reach", {
        input: { type: "object", properties: { agent: { type: "string" }, caller: { type: "string" }, kind: { type: "string", enum: ["facts", "content"] } } },
        callers: ["module"],
        run: async (input) => reachLogic(fx(), input),
      });
      return { async stop() {} };
    } };`);
}

/** Removes root's fixture (paired with the test's own tmp/tempHome cleanup). */
export function clearFakeReach(root) { if (globalThis.__fakeReach) globalThis.__fakeReach.delete(root); }
