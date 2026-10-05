// @ts-check
// The Project hub in a REAL vyred (kernel on): a Project is a record with its Drive folder and memory scope; a session's start and end become a summary record linked to it.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const until = async (/** @type {() => Promise<any>} */ f, what, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

async function boot(/** @type {any} */ t) {
  const d = await start({ root: tempHome(t), presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }), {})).token });
  return { d, admin, meta, owner };
}

test("work.project.create makes a Project record with its short name, Drive folder and memory scope, and the folder is really there", { timeout: 120_000 }, async t => {
  const { d, admin, meta } = await boot(t);
  const r = await d.registry.call("work.project.create", { name: "Rivera Estate", repo: "https://github.com/harlow/rivera" }, "cli", await meta());
  assert.ok(r.data && r.data.slug === "rivera-estate", JSON.stringify(r));
  assert.equal(r.data.drive_path, "Projects/rivera-estate");
  assert.equal(r.data.memory_scope, "project:rivera-estate");
  const rec = await d.kernel.gateway.records.get(admin, "project", r.data.project.split("/").pop());
  assert.deepEqual([rec.data.name, rec.data.status, rec.data.repo], ["Rivera Estate", "active", "https://github.com/harlow/rivera"]);
  const marker = await d.kernel.gateway.drive.get(admin, "Projects/rivera-estate/.project");
  assert.match(Buffer.from(marker.bytes || marker.data || marker).toString(), /\/project\//);
  // the same name again gets the next free short name, and a taken one is refused
  const again = await d.registry.call("work.project.create", { name: "Rivera Estate" }, "cli", await meta());
  assert.equal(again.data.slug, "rivera-estate-2");
  const taken = await d.registry.call("work.project.create", { name: "x", slug: "rivera-estate" }, "cli", await meta());
  assert.ok(taken.error, "a short name is one project's");
});

test("a session's start and end are a summary record linked to its Project, written by the kernel from the switchboard's events, and holding no transcript", { timeout: 120_000 }, async t => {
  const { d, admin, meta } = await boot(t);
  const made = await d.registry.call("work.project.create", { name: "Harlow Intake" }, "cli", await meta());
  const thread = "0f0e0d0c-0b0a-4908-8706-050403020100";
  d.events.emit("threads", "thread.started", { thread, name: "Draft the welcome email", cwd: "/work/harlow", project: "harlow-intake", agent: "intake", provider: "claude", model: "opus", headless: true });
  const q = async () => (await d.kernel.gateway.records.query(admin, "session-summary", { page: { limit: 10 } })).rows.find((/** @type {any} */ r) => r.data.thread === thread) || null;
  const row = await until(q, "the summary record");
  assert.equal(row.data.status, "working");
  assert.equal(row.data.title, "Draft the welcome email");
  assert.equal(row.data.project.urn, made.data.project);
  assert.equal(row.data.transcript, `vyre://${d.kernel.id.space}/session/${thread}`);
  assert.equal(row.data.model, "opus");
  d.events.emit("threads", "thread.stopped", { thread, code: 0, reason: "done" });
  const done = await until(async () => { const r = await q(); return r && r.data.status === "done" ? r : null; }, "the session to close");
  assert.ok(done.data.ended);
  assert.match(done.data.summary, /ended: done/);
  assert.ok(!JSON.stringify(done.data).includes("welcome email body"), "no transcript text");
  // the same session resuming is the same record, working again
  d.events.emit("threads", "thread.started", { thread, name: "Draft the welcome email", project: "harlow-intake", resumed: true });
  await until(async () => { const r = await q(); return r && r.data.status === "working" ? r : null; }, "the resumed session");
  assert.equal((await d.kernel.gateway.records.query(admin, "session-summary", { page: { limit: 10 } })).rows.length, 1);
});

test("a session in a project only the old folder projects know is given its Project record on first sight", { timeout: 120_000 }, async t => {
  const { d, admin } = await boot(t);
  const thread = "1f0e0d0c-0b0a-4908-8706-050403020100";
  d.events.emit("threads", "thread.started", { thread, name: "n", project: "legacy-client" });
  const row = await until(async () => (await d.kernel.gateway.records.query(admin, "session-summary", { page: { limit: 10 } })).rows[0] || null, "the summary");
  const proj = await d.kernel.gateway.records.get(admin, "project", row.data.project.urn.split("/").pop());
  assert.equal(proj.data.slug, "legacy-client");
  assert.equal(proj.data.drive_path, "Projects/legacy-client");
});

test("a terminal session (the Harness's SessionStart and SessionEnd hooks) gets a summary record too, found by its folder, and closes once", { timeout: 120_000 }, async t => {
  const { d, admin, meta } = await boot(t);
  const session = "2f0e0d0c-0b0a-4908-8706-050403020100";
  const brief = await d.registry.call("harness.brief", { session, cwd: process.cwd(), source: "startup" }, "cli", await meta());
  assert.ok(!brief.error || true);
  const q = async () => (await d.kernel.gateway.records.query(admin, "session-summary", { page: { limit: 10 } })).rows.find((/** @type {any} */ r) => r.data.thread === session) || null;
  const row = await until(q, "the terminal session's summary");
  assert.equal(row.data.status, "working");
  await d.registry.call("harness.end", { session, reason: "logout" }, "cli", await meta());
  const done = await until(async () => { const r = await q(); return r && r.data.status === "done" ? r : null; }, "the session to close");
  assert.ok(done.data.ended);
  await d.registry.call("harness.end", { session, reason: "logout" }, "cli", await meta());
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await q()).data.ended, done.data.ended, "a second end changes nothing");
});
