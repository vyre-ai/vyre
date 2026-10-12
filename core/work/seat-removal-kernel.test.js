// @ts-check
// A seat taken away, on a REAL vyred with the kernel on: removing a person's team-member record from a project makes the kernel emit `team-member.removed`, the work module hears it and asks the Switchboard
// to recheck (threads.seats.recheck), and the seat rule (work.project.seat) the recheck judges by says she is off that project. The recheck's own stop logic runs against the real seat answers.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, until } from "../team/team-fixture.js";
import path from "node:path";
import { stopLostSeats } from "../switchboard/project-access.js";

test("removing a member's seat reaches the Switchboard's recheck, and her session that joined that project's group is stopped", { timeout: 150_000 }, async t => {
  const { d, tool, project, logs } = await boot(t);
  // the box keeps its projects under /work; here that is the temp home's projects folder, so the project counts as mapped (a project outside it is no project of the box's)
  const was = process.env.VYRE_WORK; process.env.VYRE_WORK = path.dirname(String((await tool("projects.list", {})).projects.find((/** @type {any} */ p) => p.slug === project.slug).home));
  t.after(() => { if (was === undefined) delete process.env.VYRE_WORK; else process.env.VYRE_WORK = was; });
  const OWNER = d.kernel.id.owner, SPACE = d.kernel.id.space, BEN = "per_" + "c".repeat(26);
  const oc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(oc, { person: BEN, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const R = d.kernel.gateway.records, urn = `vyre://${SPACE}/project/${project.record}`;
  const seat = async () => { const r = await d.registry.call("work.project.seat", { project: project.slug, person: BEN }, "module:switchboard", {}); return r.data; };
  assert.deepEqual(await seat(), { exists: true, owner: false, team: false });
  const row = await R.create(oc, "team-member", { name: "ben", actor: { actor: { kind: "person", id: BEN, space: SPACE } }, kind: "person", project: { urn } });
  assert.equal((await seat()).team, true, "on the team: the seat rule says so");

  // the real recheck tool, watched: the kernel's event must reach it through the work module
  const real = /** @type {any} */ (d.registry.tools.get("threads.seats.recheck"));
  const orig = real.run, heard = /** @type {string[]} */ ([]);
  real.run = async (/** @type {any} */ i, /** @type {any} */ m) => { heard.push("recheck"); return orig(i, m); };
  t.after(() => { real.run = orig; });
  await R.remove(oc, "team-member", row.id, row.version);
  // 60 s, not the fixture's 15: a box running other test files beside this one is slow to deliver the kernel's event, and a miss says what the daemon logged
  await until(() => heard.length > 0, "the work module to ask the Switchboard to recheck after team-member.removed", 60_000).catch((/** @type {Error} */ e) => { throw new Error(`${e.message}; the daemon logged: ${logs.slice(-15).join(" | ").slice(0, 1500)}`); });
  assert.equal((await seat()).team, false, "off the team: the seat rule says so");

  // her running session (it joined the group of this project when it started) is judged by the real seat answer
  const sb = /** @type {any} */ ({ canon: (/** @type {string} */ p) => p, record: () => ({ cwd: "/work/projects/other" }), live: new Map([["t-ben", { launch: { accountRun: { person: BEN, uid: 2000, projects: [project.slug] } } }]]),
    deps: { owner: () => OWNER, log() {}, call: async (/** @type {string} */ name, /** @type {any} */ i) => d.registry.call(name, i, "module:switchboard", {}) } });
  const stopped = /** @type {string[]} */ ([]);
  assert.deepEqual(await stopLostSeats(sb, { stop: async (id) => { stopped.push(id); } }), ["t-ben"]);
});
