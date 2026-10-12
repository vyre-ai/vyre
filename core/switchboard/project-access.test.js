// @ts-check
// Which project folders a session joins on a team server (core/switchboard/project-access.js): from the account's person and the work module's seat rule, never a caller's label.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { personOf, projectsFor, ensureFolder, stopLostSeats, socketGid, regroupSocket, syncProjects, launchAccess } from "./project-access.js";
import { syncAll } from "../../lib/project-folders.js";
import { Switchboard } from "./index.js";

const PROJECTS = [
  { slug: "alpha", home: "/work/projects/alpha", workspaces: [{ path: "/work/projects/alpha/site" }] },
  { slug: "beta", home: "/work/projects/beta", workspaces: [] },
  { slug: "gamma", home: "/work/projects/gamma" },
  { slug: "elsewhere", home: "/srv/elsewhere" },
];
const SEATS = /** @type {Record<string, Record<string, { owner?: boolean, team?: boolean, level?: string }>>} */ ({ ben: { alpha: { team: true }, gamma: { owner: true } }, cara: { beta: { team: true } }, vik: { alpha: { team: true, level: "viewer" }, beta: { team: true, level: "contributor" }, gamma: { team: true, level: "lead" } } });

/** A switchboard with the two tools it asks of the others. @param {{ owner?: string | null, seats?: typeof SEATS, log?: string[], live?: Map<string, any>, recs?: Record<string, any> }} [o] */
const sb = (o = {}) => {
  const seats = o.seats || SEATS, calls = /** @type {string[]} */ ([]);
  return /** @type {any} */ ({
    canon: (/** @type {string} */ p) => p, calls, live: o.live || new Map(), record: (/** @type {string} */ id) => (o.recs || {})[id],
    deps: { owner: () => (o.owner === undefined ? "owen" : o.owner), log: (/** @type {string} */ m) => (o.log || []).push(m),
      call: async (/** @type {string} */ tool, /** @type {any} */ i) => {
        calls.push(tool);
        if (tool === "projects.list") return { data: { projects: PROJECTS } };
        if (tool === "work.project.seat") { const s = (seats[i.person] || {})[i.project]; return { data: s ? { exists: true, owner: Boolean(s.owner), team: Boolean(s.team), level: s.level || (s.owner ? "lead" : s.team ? "contributor" : null) } : { exists: true, owner: false, team: false } }; }
        throw new Error(`unexpected ${tool}`);
      } },
  });
};

test("the projects a session joins: a member's seats, the owner's all of the ones under /work, no resolvable person none", async () => {
  assert.deepEqual(await projectsFor(sb(), { person: "ben" }), ["alpha", "gamma"], "ben: his two seats, in the box's order; the folder outside /work is no project here");
  assert.deepEqual(await projectsFor(sb(), { person: "cara" }), ["beta"]);
  assert.deepEqual(await projectsFor(sb(), { person: "dan" }), [], "a person with no seat has no group");
  assert.deepEqual(await projectsFor(sb(), { person: "owen" }), ["alpha", "beta", "gamma"], "the owner reaches every project");
  assert.deepEqual(await projectsFor(sb({ owner: null }), { person: null }), [], "no person and no owner to stand for: never all");
  assert.deepEqual(await projectsFor(sb({ owner: "" }), {}), [], "an owner that cannot be read is no person");
});

test("an account that records no person gets no project, whoever the home's owner is; only a verified owner behind the launch makes it the owner's", async () => {
  assert.deepEqual(await projectsFor(sb(), { person: null }), [], "a member's account row that lost its person gets nothing");
  assert.deepEqual(await projectsFor(sb(), {}), [], "nor one with no person field at all");
  assert.deepEqual(await projectsFor(sb(), { person: "" }, { person: "ben" }), [], "a verified MEMBER behind a person-less account is not the owner: nothing");
  assert.deepEqual(await projectsFor(sb(), { person: null }, { person: "owen" }), ["alpha", "beta", "gamma"], "the owner's own turn on the home's legacy account: the owner's reach");
  assert.equal(personOf(sb(), { person: null }, {}), null);
});

test("a label the caller sent decides nothing: the list comes from the account's person", async () => {
  // the launch's own words (agent, scope) can only narrow what the account's person has
  assert.deepEqual(await projectsFor(sb(), { person: "cara" }, { agent: null, scope: { projects: "*" } }), ["beta"]);
  assert.deepEqual(await projectsFor(sb(), { person: "cara" }, { agent: "kit", scope: { projects: ["alpha", "beta"] } }), ["beta"], "an agent's grant never adds a project the person is not on");
});

test("an agent's turn on her account: the intersection of her seats and the agent's grant; no grant is none", async () => {
  assert.deepEqual(await projectsFor(sb(), { person: "ben" }, { agent: "kit", scope: { projects: ["alpha"] } }), ["alpha"]);
  assert.deepEqual(await projectsFor(sb(), { person: "ben" }, { agent: "kit", scope: { projects: "*" } }), ["alpha", "gamma"]);
  assert.deepEqual(await projectsFor(sb(), { person: "ben" }, { agent: "kit", scope: null }), []);
  assert.deepEqual(await projectsFor(sb(), { person: "ben" }, { agent: "kit" }), []);
});

test("the project the session works in comes first, and a person on more than 64 carries 64 (and the log says so)", async () => {
  assert.deepEqual(await projectsFor(sb(), { person: "ben" }, { cwd: "/work/projects/gamma/docs" }), ["gamma", "alpha"]);
  const many = Array.from({ length: 70 }, (_, i) => ({ slug: `p${i}`, home: `/work/projects/p${i}` }));
  const log = /** @type {string[]} */ ([]), s = sb({ log });
  s.deps.call = async (/** @type {string} */ tool) => tool === "projects.list" ? { data: { projects: many } } : { data: { exists: true, owner: true, team: false } };
  const got = await projectsFor(s, { person: "ben" }, { cwd: "/work/projects/p69" });
  assert.equal(got.length, 64); assert.equal(got[0], "p69", "the one it works in made the cut");
  assert.match(log.join(" "), /70 projects/);
});

test("the first launch in a project's folder hands every folder of the project to its group; a folder in no project is left", async () => {
  const asked = /** @type {string[][]} */ ([]);
  const ask = /** @type {any} */ (async (/** @type {string} */ p, /** @type {string} */ f) => { asked.push([p, f]); return { migrated: true }; });
  assert.equal(await ensureFolder(sb(), "/work/projects/alpha/site/src", undefined, { ask }), "alpha");
  assert.deepEqual(asked, [["alpha", "/work/projects/alpha"], ["alpha", "/work/projects/alpha/site"]]);
  assert.equal(await ensureFolder(sb(), "/work/scratch", undefined, { ask }), null);
  assert.equal(await ensureFolder(sb(), "/srv/elsewhere", undefined, { ask }), null, "outside /work nothing is asked");
  assert.equal(asked.length, 2);
});

test("a folder the spawner refuses stops the launch with the reason and a next step", async () => {
  const ask = /** @type {any} */ (async () => { throw new Error("/work/projects/alpha is owned by uid 2000, not by Vyre"); });
  await assert.rejects(ensureFolder(sb(), "/work/projects/alpha", undefined, { ask }), (/** @type {any} */ e) => e.code === "sandbox_failed" && /owned by uid 2000/.test(e.message) && /owned by Vyre and is inside/.test(e.message));
});

test("a first launch that takes a while says what it is doing", async () => {
  const said = /** @type {string[]} */ ([]);
  const ask = /** @type {any} */ (() => new Promise(r => setTimeout(() => r({ migrated: true }), 3300)));
  await ensureFolder(sb(), "/work/projects/beta", t => said.push(t), { ask });
  assert.equal(said.length, 1); assert.match(said[0], /first start in a project/);
});

test("projects.sync: every project's folders, one that fails does not stop the rest, a second run changes nothing", async () => {
  const done = new Set(), seen = /** @type {string[]} */ ([]);
  const ask = /** @type {any} */ (async (/** @type {string} */ p, /** @type {string} */ f) => { seen.push(f); if (p === "beta") throw new Error("not a real folder"); const fresh = !done.has(f); done.add(f); return { migrated: fresh }; });
  const list = () => sb().deps.call("projects.list", {});
  const first = await syncAll(list, ask);
  assert.deepEqual(first.projects.map(r => [r.project, r.folders, r.migrated, r.error ? "error" : "ok"]), [["alpha", 2, 2, "ok"], ["beta", 1, 0, "error"], ["gamma", 1, 1, "ok"]]);
  assert.match(String(first.projects[1].error), /not a real folder/);
  const second = await syncAll(list, ask);
  assert.deepEqual(second.projects.map(r => r.migrated), [0, 0, 0]);
});

test("a seat taken away stops the session that joined that project's group, whatever folder it works in; one that still has every seat is left alone", async () => {
  const mk = (/** @type {string} */ person, /** @type {string[]} */ projects) => ({ launch: { accountRun: { person, uid: 2000, projects } } });
  // ben is on alpha and gamma; cara on beta only. Both sessions work in alpha's or beta's folder, but joined the groups listed.
  const live = new Map([["t-ben-both", mk("ben", ["alpha", "gamma"])], ["t-ben-lost", mk("ben", ["alpha", "beta"])], ["t-cara", mk("cara", ["beta"])], ["t-owner", mk("owen", ["alpha", "beta", "gamma"])], ["t-agent", { launch: {} }], ["t-none", mk("ben", [])]]);
  const recs = Object.fromEntries([...live.keys()].map(k => [k, { cwd: "/work/projects/alpha" }]));
  const stopped = /** @type {string[]} */ ([]);
  const got = await stopLostSeats(sb({ live, recs }), { stop: async (id) => { stopped.push(id); } });
  assert.deepEqual(got, ["t-ben-lost"], "ben lost beta though his session works in alpha, where he still has a seat");
  assert.deepEqual(stopped, ["t-ben-lost"]);
});

test("a project deleted or unmapped since the launch is not a lost seat: the owner's and a member's sessions that joined it are left alone", async () => {
  const live = new Map([["t-owner", { launch: { accountRun: { person: "owen", uid: 2000, projects: ["alpha", "gone"] } } }], ["t-ben", { launch: { accountRun: { person: "ben", uid: 2001, projects: ["alpha", "gone"] } } }]]);
  const recs = { "t-owner": { cwd: "/work/projects/alpha" }, "t-ben": { cwd: "/work/projects/alpha" } };
  assert.deepEqual(await stopLostSeats(sb({ live, recs }), { stop: async () => {} }), [], "`gone` is not in the project list any more");
});

test("a session socket's group is its account's (gid equals uid), or the box agent's", () => {
  assert.equal(socketGid({ uid: 2007 }), 2007);
  const was = process.env.VYRE_AGENT_GID;
  try { delete process.env.VYRE_AGENT_GID; assert.equal(socketGid(null), 1001); process.env.VYRE_AGENT_GID = "1500"; assert.equal(socketGid(undefined), 1500); process.env.VYRE_AGENT_GID = "x"; assert.equal(socketGid(null), 1001); }
  finally { if (was === undefined) delete process.env.VYRE_AGENT_GID; else process.env.VYRE_AGENT_GID = was; }
});

test("a socket kept across a hop is given the new account's group, and one that already has it is left; a refusal is logged, not thrown", () => {
  const calls = /** @type {number[]} */ ([]), log = /** @type {string[]} */ ([]);
  const have = { gid: 2000, setGroup: (/** @type {number} */ g) => calls.push(g) };
  regroupSocket(have, { uid: 2001 }, m => log.push(m)); assert.deepEqual(calls, [2001]); assert.equal(have.gid, 2001);
  regroupSocket(have, { uid: 2001 }, m => log.push(m)); assert.deepEqual(calls, [2001], "the same group: nothing");
  regroupSocket({ gid: 1, setGroup() { throw new Error("EPERM"); } }, { uid: 2002 }, m => log.push(m)); assert.match(log[0], /EPERM/);
  regroupSocket(null, { uid: 1 }, m => log.push(m)); regroupSocket({ gid: 1 }, { uid: 2 }, m => log.push(m));
});

test("projects.sync where sessions do not run through the spawner is refused with where to run it", async () => {
  const was = process.env.VYRE_SESSIONS_SPAWNER;
  try { delete process.env.VYRE_SESSIONS_SPAWNER; await assert.rejects(syncProjects(sb()), (/** @type {any} */ e) => e.code === "unavailable" && /team server's box/.test(e.message)); }
  finally { if (was !== undefined) process.env.VYRE_SESSIONS_SPAWNER = was; }
});

test("the launch step: an account's launch carries its projects; a launch on no account carries none and asks only for its folder", async () => {
  const s = sb(); const o = { agent: null, scope: null };
  const rec = { cwd: "/work/projects/gamma", project: "gamma" };
  s.emit = () => {};
  const got = await launchAccess(s, rec, { ...o, accountRun: { uid: 2000, person: "ben" } }, "t1").catch(e => e);
  // the folder step asks the real spawner, which is not there on a test box: the refusal names the next step
  assert.equal(got.code, "sandbox_failed"); assert.match(got.message, /owned by Vyre and is inside/);
  const none = await launchAccess(s, { cwd: "/srv/elsewhere" }, { ...o, accountRun: { uid: 2000, person: "ben" } }, "t2");
  assert.deepEqual(none.accountRun.projects, ["alpha", "gamma"]);
  const agent = await launchAccess(s, { cwd: "/srv/elsewhere" }, o, "t3");
  assert.equal(agent.accountRun, undefined);
});

test("a launch on an account with no person says why it gets no project folders", async () => {
  const s = sb(), said = /** @type {string[]} */ ([]);
  s.emit = (/** @type {string} */ _t, /** @type {any} */ p) => said.push(p.text);
  const got = await launchAccess(s, { cwd: "/srv/elsewhere" }, { accountRun: { uid: 2000, person: null }, kernelTurn: { asker: "ben" } }, "t9");
  assert.deepEqual(got.accountRun.projects, []);
  assert.match(said.join(" "), /no person recorded.*no project folders.*AI accounts/);
  said.length = 0;
  const own = await launchAccess(s, { cwd: "/srv/elsewhere" }, { accountRun: { uid: 2000, person: null }, kernelTurn: { asker: "owen" } }, "t10");
  assert.deepEqual(own.accountRun.projects, ["alpha", "beta", "gamma"]); assert.equal(said.length, 0);
});

test("a viewer's session gets no group for the project it only reads, keeps the others at their levels, and is not started in the project's folder", async () => {
  assert.deepEqual(await projectsFor(sb(), { person: "vik" }), ["beta", "gamma"], "alpha is read-only for vik: no group, so no write at the folder; a contributor and a lead keep theirs");
  const s = sb();
  s.emit = () => {};
  const got = await launchAccess(s, { cwd: "/work/projects/alpha", project: "alpha" }, { accountRun: { uid: 2000, person: "vik" } }, "tv").catch(e => e);
  assert.equal(got.code, "not_allowed");
  assert.match(got.message, /read-only access to this project \(viewer\)/); assert.match(got.message, /Ask the project's owner or a lead/);
});

test("a chat message from a viewer of the chat's project is refused in words; a contributor's, and a chat in no project, go through", async () => {
  const fake = /** @type {any} */ ({ deps: { kernelSession: async () => ({}), call: sb().deps.call } });
  const ask = (/** @type {any} */ rec, /** @type {string} */ asker) => Switchboard.prototype.assertAsker.call(fake, "t", rec, { chat: "c", asker });
  await assert.rejects(() => ask({ project: "alpha" }, "vik"), (/** @type {any} */ e) => e.code === "not_allowed" && /read-only access to this project \(viewer\)/.test(e.message) && /Ask the project's owner or a lead/.test(e.message));
  await ask({ project: "beta" }, "vik");
  await ask({ project: "gamma" }, "vik");
  await ask({}, "vik");
});

test("a seat made read-only stops the session that joined the project's group; a seat with no known level is no group", async () => {
  // vik joined alpha when it was a contributor seat; alpha is a viewer seat now (SEATS), so the session is stopped
  const live = new Map([["t-vik", { launch: { accountRun: { person: "vik", uid: 2000, projects: ["alpha", "beta"] } } }]]);
  const stopped = /** @type {string[]} */ ([]);
  assert.deepEqual(await stopLostSeats(sb({ live, recs: { "t-vik": { cwd: "/work/projects/beta" } } }), { stop: async (id) => { stopped.push(id); } }), ["t-vik"]);
  const odd = { zed: { alpha: { team: true, level: "boss" } } };
  assert.deepEqual(await projectsFor(sb({ seats: odd }), { person: "zed" }), [], "an unknown level never gets the read-write group");
});
