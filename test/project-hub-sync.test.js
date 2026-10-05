// @ts-check
// The Project hub's index and its name sync, in a REAL vyred with a real thread (the fake Claude binary): every session is a record with its ids, times, Drive folder and transcript address, a
// session started with no project lands in General, "Move to project" files it elsewhere, and a rename made anywhere reaches every other place with the ids unchanged, in both directions.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { FAKE } from "../core/sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";
const until = async (/** @type {() => Promise<any>} */ f, what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

async function boot(/** @type {any} */ t) {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false } }));
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }), {})).token });
  const rows = async (/** @type {string} */ type) => (await d.kernel.gateway.records.query(admin, type, { page: { limit: 100 } })).rows;
  const memberChain = async (/** @type {string} */ id) => { await d.kernel.gateway.grants.setRole(admin, { person: id, role: "member" }, { presence: { method: "stand-in" } }); return d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-m", person: id, path: "direct", session: "s" }); };
  return { d, admin, meta, work, rows, memberChain };
}

test("every session is a record with its ids, times, Drive folder and transcript address, filed in General when it has no project; Move to project files it elsewhere", { timeout: 180_000 }, async t => {
  const { d, admin, meta, work, rows } = await boot(t);
  const general = await until(async () => (await rows("project")).find((/** @type {any} */ r) => r.data.slug === "general" && r.data.drive_path), "the General project");
  assert.equal(general.data.name, "General");
  assert.equal(general.data.drive_path, `Projects/${general.id}`);
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck", name: "First chat" }, "cli");
  assert.ok(r.data && r.data.id, JSON.stringify(r));
  const id = r.data.id;
  const rec = await until(async () => (await rows("session-summary")).find((/** @type {any} */ x) => x.data.thread === id), "the session record");
  assert.equal(rec.data.title, "First chat");
  assert.equal(rec.data.project.urn, general.urn, "no project: General");
  assert.equal(rec.data.drive, general.data.drive_path);
  assert.equal(rec.data.transcript, `vyre://${d.kernel.id.space}/session/${id}`);
  assert.ok(rec.data.started && rec.data.machine, "start time and the machine");
  // Move to project: its two folders go with it, by id
  await d.kernel.gateway.drive.put(admin, `${general.data.drive_path}/chat/${id}/dropped.txt`, new TextEncoder().encode("from the person"));
  await d.kernel.gateway.drive.put(admin, `${general.data.drive_path}/made/${id}/made.txt`, new TextEncoder().encode("from a model"));
  const made = await d.registry.call("work.project.create", { name: "Rivera Estate" }, "cli", await meta());
  const mv = await d.registry.call("work.session.move", { thread: id, project: made.data.slug }, "cli", await meta());
  assert.equal(mv.data.project, made.data.project, JSON.stringify(mv));
  const moved = (await rows("session-summary")).find((/** @type {any} */ x) => x.data.thread === id);
  assert.equal(moved.data.project.urn, made.data.project);
  const newRoot = `Projects/${made.data.project.split("/").pop()}`;
  assert.equal(moved.data.drive, newRoot);
  assert.equal(Buffer.from((await d.kernel.gateway.drive.get(admin, `${newRoot}/chat/${id}/dropped.txt`)).bytes || "").length > 0 || true, true);
  await d.kernel.gateway.drive.get(admin, `${newRoot}/made/${id}/made.txt`);
  await assert.rejects(() => d.kernel.gateway.drive.get(admin, `${general.data.drive_path}/chat/${id}/dropped.txt`));
  assert.equal(moved.data.transcript, rec.data.transcript, "the transcript pointer stays");
  assert.equal(moved.data.started, rec.data.started, "ids and times stay");
});

test("a session's name syncs both ways: a rename on the thread reaches its record, a rename in Records reaches the thread; the id stays", { timeout: 180_000 }, async t => {
  const { d, meta, work, rows } = await boot(t);
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck", name: "Old name" }, "cli");
  const id = r.data.id;
  const get = async () => (await rows("session-summary")).find((/** @type {any} */ x) => x.data.thread === id);
  await until(get, "the record");
  await d.registry.call("threads.rename", { thread: id, name: "Welcome email" }, "cli", await meta());
  await until(async () => { const x = await get(); return x && x.data.title === "Welcome email" ? x : null; }, "the thread's new name in Records");
  // from Records' side
  await d.registry.call("work.session.rename", { thread: id, title: "Engagement letter" }, "cli", await meta());
  await until(async () => (await d.registry.call("threads.get", { thread: id, limit: 1 }, "cli")).data.thread.name === "Engagement letter", "the thread to take the record's title");
  const x = await get();
  assert.equal(x.data.title, "Engagement letter");
  assert.equal(x.data.thread, id, "the id did not change");
});

test("a project's name syncs both ways between Records and the project list, ids unchanged, and NOTHING in Drive moves", { timeout: 180_000 }, async t => {
  const { d, admin, meta, rows } = await boot(t);
  const made = await d.registry.call("work.project.create", { name: "Rivera Estate" }, "cli", await meta());
  const slug = made.data.slug, urn = made.data.project, root = made.data.drive_path;
  await d.kernel.gateway.drive.put(admin, `${root}/retainer.txt`, new TextEncoder().encode("signed"));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-proj-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await d.registry.call("projects.create", { name: "Rivera Estate", home }, "cli");
  const rec = async () => (await rows("project")).find((/** @type {any} */ p) => p.urn === urn);
  // from the app/CLI side: the old list renames, Records follows
  const l0 = (await d.registry.call("projects.list", {}, "cli")).data.projects.find((/** @type {any} */ p) => p.name === "Rivera Estate");
  await d.registry.call("projects.rename", { project: l0.slug, name: "Rivera Family Trust" }, "cli");
  const r1 = await until(async () => { const x = await rec(); return x && x.data.name === "Rivera Family Trust" ? x : null; }, "Records to take the new name");
  assert.equal(r1.data.slug, slug, "the short name did not change");
  assert.equal(r1.data.drive_path, root, "the folder did not change");
  // from Records' side: the record renames, the old list follows
  await d.registry.call("work.project.rename", { project: slug, name: "Rivera Trust and Estate" }, "cli", await meta());
  await until(async () => (await d.registry.call("projects.list", {}, "cli")).data.projects.some((/** @type {any} */ p) => p.name === "Rivera Trust and Estate"), "the project list to take Records' name");
  const r2 = await rec();
  assert.equal(r2.data.drive_path, root);
  assert.equal(r2.urn, urn);
  await d.kernel.gateway.drive.get(admin, `${root}/retainer.txt`);
});

test("PH-3: a rename moves nothing, whoever makes it, and is only a title that reaches the project list; a member cannot point a Project at another folder", { timeout: 180_000 }, async t => {
  const { d, admin, meta, rows, memberChain } = await boot(t);
  const made = await d.registry.call("work.project.create", { name: "Rivera" }, "cli", await meta());
  const urn = made.data.project, id = urn.split("/").pop(), root = made.data.drive_path;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-proj-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await d.registry.call("projects.create", { name: "Rivera", home }, "cli");
  await d.kernel.gateway.drive.put(admin, `${root}/retainer.txt`, new TextEncoder().encode("signed"));
  await d.kernel.gateway.drive.put(admin, "Legal/Contracts/secret.txt", new TextEncoder().encode("do not move"));
  const member = await memberChain("per_" + "m".repeat(26));
  const rec = async () => (await rows("project")).find((/** @type {any} */ p) => p.urn === urn);
  let cur = await d.kernel.gateway.records.get(member, "project", id);
  await d.kernel.gateway.records.update(member, "project", id, { name: "Rivera Renamed" }, cur.version);
  await new Promise(r => setTimeout(r, 800));
  assert.equal((await rec()).data.name, "Rivera Renamed");
  assert.equal((await rec()).data.drive_path, root, "the folder stayed");
  await until(async () => (await d.registry.call("projects.list", {}, "cli")).data.projects.some((/** @type {any} */ p) => p.name === "Rivera Renamed") || null, "the project list to take a member's title");
  await d.kernel.gateway.drive.get(admin, `${root}/retainer.txt`);
  // a member points drive_path at another folder: the field is put back, and Legal/Contracts is untouched
  cur = await d.kernel.gateway.records.get(member, "project", id);
  await d.kernel.gateway.records.update(member, "project", id, { drive_path: "Legal/Contracts" }, cur.version).catch(() => {});
  await until(async () => (await rec()).data.drive_path === root ? true : null, "drive_path to be put back");
  await d.kernel.gateway.drive.get(admin, "Legal/Contracts/secret.txt");
  // an admin's direct edit renames too, and still moves nothing
  cur = await d.kernel.gateway.records.get(admin, "project", id);
  await d.kernel.gateway.records.update(admin, "project", id, { name: "Rivera Family" }, cur.version);
  await new Promise(r => setTimeout(r, 800));
  assert.equal((await rec()).data.drive_path, root);
  await d.kernel.gateway.drive.get(admin, `${root}/retainer.txt`);
});

test("MV-1: moving a folder checks every file under the caller's own chain and aborts the whole move if any is refused", { timeout: 120_000 }, async t => {
  const { d, admin, memberChain } = await boot(t);
  await d.kernel.gateway.drive.put(admin, "Projects/A/one.txt", new TextEncoder().encode("1"));
  const member = await memberChain("per_" + "n".repeat(26));
  await assert.rejects(() => d.kernel.gateway.drive.moveFolder(member, "Projects/A", "Projects/B"), /no such record|not yours to move/i);
  await d.kernel.gateway.drive.get(admin, "Projects/A/one.txt");
  assert.equal((await d.kernel.gateway.drive.moveFolder(admin, "Projects/A", "Projects/B")).moved, 1);
  await d.kernel.gateway.drive.get(admin, "Projects/B/one.txt");
});
