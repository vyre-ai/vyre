// @ts-check
// core/team, step 1 of the Migration (docs/adr/0031-teammates.md): the tables, the team.* tools,
// the serial inbox (priority ordered, one running request per teammate) and the notes file with
// versions, against the fake claude driver (core/switchboard/testing/fake-claude.js).
//
// A teammate's turn scripts a tool call back into vyred with the fake driver's "vyre <tool>
// <json>" prompt line, which fake-claude.js now finds anywhere in the prompt (not only at the
// very start), so a request's <vyre-request> wrapper does not hide it. team.done/team.fail also
// take `request` as optional and default to the caller's one running request, so a teammate's
// script never needs to know the id ADR 0031 gave the request before it existed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);

const until = async (fn, what, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 40));
  }
};

/** A vyred in a temp home, on the fake claude, with a project already made. */
async function boot(t) {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // projectsDir must live under root: its default (~/Vyre/projects) is the user's real home,
  // never a temp one (RULES: temp homes only).
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false }, projectsDir: path.join(root, "projects") }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const tool = async (name, input, caller = "cli") => {
    const r = await call(name, input, { root, caller, timeout: 20_000 });
    if (r.error) throw Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code });
    return r.data;
  };
  const project = await tool("projects.create", { name: "Harlow Legal" });
  return { root, d, tool, project };
}

test("team.add makes a teammate; team.list shows it asleep with an empty queue", async t => {
  const { tool, project } = await boot(t);
  const tm = await tool("team.add", { project: project.slug, role: "design", brief: "visual design and UI copy" });
  assert.equal(tm.agent, `design-${project.slug}`);
  assert.equal(tm.state, "asleep");
  const [row] = await tool("team.list", { project: project.slug });
  assert.equal(row.role, "design");
  assert.equal(row.queued, 0);
  assert.equal(row.state, "asleep");
});

test("team.add is a person's own act: a bare mcp caller is refused", async t => {
  const { root, project } = await boot(t);
  const r = await call("team.add", { project: project.slug, role: "design" }, { root, caller: "mcp", timeout: 20_000 });
  assert.ok(r.error);
  assert.equal(r.error.code, "denied");
});

test("a request runs, the teammate closes it with team.done, and the result comes back", async t => {
  const { tool, project } = await boot(t);
  await tool("team.add", { project: project.slug, role: "design", brief: "visual design" });
  const ask = await tool("team.ask", { to: "design", project: project.slug, wait: true,
    text: 'vyre team.done {"result":"Split the form into 4 steps of 3 to 5 fields."}' });
  assert.equal(ask.state, "done");
  assert.match(ask.result, /4 steps/);
  const status = await tool("team.status", { request: ask.request });
  assert.equal(status.state, "done");
  assert.equal(status.teammate, `design-${project.slug}`);
  const [row] = await tool("team.list", { project: project.slug });
  assert.equal(row.state, "idle"); // still has a thread, just not mid-request
  assert.equal(row.last_result.request, ask.request);
});

test("team.fail closes a request as failed, with why", async t => {
  const { tool, project } = await boot(t);
  await tool("team.add", { project: project.slug, role: "qa" });
  const ask = await tool("team.ask", { to: "qa", project: project.slug, wait: true,
    text: 'vyre team.fail {"reason":"the fixture has no login for this environment"}' });
  assert.equal(ask.state, "failed");
  assert.match(ask.result, /no login/);
});

test("a turn that ends without team.done or team.fail closes the request as failed, not stuck", async t => {
  const { tool, project } = await boot(t);
  await tool("team.add", { project: project.slug, role: "writer" });
  // No "vyre team.done ..." line: the fake driver just echoes this back and the turn ends.
  const ask = await tool("team.ask", { to: "writer", project: project.slug, text: "draft the intake copy" });
  const req = await until(async () => { const s = await tool("team.status", { request: ask.request }); return s.state !== "queued" && s.state !== "running" ? s : null; }, "the request to close");
  assert.equal(req.state, "failed");
  assert.match(req.result, /without team\.done or team\.fail/);
});

test("team.done is refused for another teammate's request, and for one that is not running", async t => {
  const { root, tool, project } = await boot(t);
  await tool("team.add", { project: project.slug, role: "design" });
  await tool("team.add", { project: project.slug, role: "backend" });
  const ask = await tool("team.ask", { to: "design", project: project.slug, wait: true, text: 'vyre team.done {"result":"ok"}' });
  assert.equal(ask.state, "done");
  // Called plainly (no agent key), team.done has no teammate to default to.
  const r = await call("team.done", { request: ask.request, result: "again" }, { root, caller: "mcp", timeout: 20_000 });
  assert.ok(r.error);
  assert.equal(r.error.code, "denied");
});

test("priority: urgent runs before normal and low queued ahead of it", async t => {
  const { tool, project } = await boot(t);
  await tool("team.add", { project: project.slug, role: "design" });
  // Starve the teammate of a slot so the first request is picked (running) but cannot launch yet,
  // which holds the second and third in the queue where priority order can be observed.
  await tool("sessions.limits.set", { project: project.slug, max_active: 0 });
  const first = await tool("team.ask", { to: "design", project: project.slug, priority: "normal", text: 'vyre team.done {"result":"first"}' });
  await until(async () => (await tool("team.status", { request: first.request })).state === "running", "the first request to be picked");
  const low = await tool("team.ask", { to: "design", project: project.slug, priority: "low", text: 'vyre team.done {"result":"low"}' });
  const urgent = await tool("team.ask", { to: "design", project: project.slug, priority: "urgent", text: 'vyre team.done {"result":"urgent"}' });
  assert.equal(low.state, "queued");
  assert.equal(urgent.state, "queued");
  await tool("sessions.limits.set", { project: project.slug, max_active: 1 });
  await until(async () => (await tool("team.status", { request: first.request })).state === "done", "the first request to finish");
  await until(async () => (await tool("team.status", { request: urgent.request })).state !== "queued", "urgent to be picked");
  const urgentAfter = await tool("team.status", { request: urgent.request });
  const lowAfter = await tool("team.status", { request: low.request });
  assert.notEqual(urgentAfter.state, "queued");
  assert.equal(lowAfter.state, "queued"); // still behind urgent; only one runs at a time
});

test("notes: team.notes set writes a version and the project's notes.md; get reads it back", async t => {
  const { tool, project } = await boot(t);
  const tm = await tool("team.add", { project: project.slug, role: "design" });
  const first = await tool("team.notes", { action: "set", agent: tm.agent, text: "# design\n\nScope: the intake form." });
  assert.equal(first.versions.length, 1);
  const second = await tool("team.notes", { action: "set", agent: tm.agent, text: "# design\n\nScope: the intake form.\n\nDone: split into 4 steps." });
  assert.equal(second.versions.length, 2);
  const got = await tool("team.notes", { action: "get", agent: tm.agent });
  assert.match(got.text, /split into 4 steps/);
  const onDisk = fs.readFileSync(path.join(project.home, ".vyre", "team", "design", "notes.md"), "utf8");
  assert.equal(onDisk, got.text);
});
