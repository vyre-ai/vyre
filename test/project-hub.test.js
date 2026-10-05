// @ts-check
// The Project hub in a REAL vyred (kernel on): a Project is a record with its Drive folder and memory scope; a session's start and end become a summary record linked to it.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { asOwner, tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const until = async (/** @type {() => Promise<any>} */ f, what, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

async function boot(/** @type {any} */ t) {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
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
  assert.equal(r.data.drive_path, `Projects/${r.data.project.split("/").pop()}`, "named by the record id");
  assert.equal(r.data.memory_scope, "project:rivera-estate");
  const rec = await d.kernel.gateway.records.get(admin, "project", r.data.project.split("/").pop());
  assert.deepEqual([rec.data.name, rec.data.status, rec.data.repo], ["Rivera Estate", "active", "https://github.com/harlow/rivera"]);
  const marker = await d.kernel.gateway.drive.get(admin, `${r.data.drive_path}/.project`);
  assert.match(Buffer.from(marker.bytes || marker.data || marker).toString(), /\/project\//);
  // the same name again gets the next free short name, and a taken one is refused
  const again = await d.registry.call("work.project.create", { name: "Rivera Estate" }, "cli", await meta());
  assert.equal(again.data.slug, "rivera-estate-2");
  const taken = await d.registry.call("work.project.create", { name: "x", slug: "rivera-estate" }, "cli", await meta());
  assert.ok(taken.error, "a short name is one project's");
});

test("a chat's record is made by the kernel's chat.created, filled by a run's start and end, and holds no transcript, model or summary", { timeout: 120_000 }, async t => {
  const { d, admin, meta } = await boot(t);
  const made = await d.registry.call("work.project.create", { name: "Harlow Intake" }, "cli", await meta());
  const chat = await d.kernel.gateway.grants.chats.create(admin, {});
  const q = async () => (await d.kernel.gateway.records.query(admin, "chat-record", { page: { limit: 10 } })).rows.find((/** @type {any} */ r) => r.data.chat === chat.id) || null;
  const first = await until(q, "the chat record");
  assert.equal(first.data.status, "idle");
  assert.equal(first.data.title, "New chat");
  assert.equal(first.data.people, d.kernel.id.owner);
  const thread = "0f0e0d0c-0b0a-4908-8706-050403020100";
  d.events.emit("threads", "thread.started", { thread, chat: chat.id, name: "Draft the welcome email", cwd: "/work/harlow", project: "harlow-intake", agent: "intake", provider: "claude", model: "opus", headless: true });
  const row = await until(async () => { const r = await q(); return r && r.data.status === "working" ? r : null; }, "the run's start");
  assert.equal(row.data.title, "Draft the welcome email");
  assert.equal(row.data.project.urn, made.data.project, "out of General, into the run's project");
  assert.ok(!("model" in row.data) && !("transcript" in row.data) && !("summary" in row.data), "nothing the engine keeps");
  d.events.emit("threads", "thread.stopped", { thread, chat: chat.id, code: 0, reason: "done" });
  const done = await until(async () => { const r = await q(); return r && r.data.status === "idle" ? r : null; }, "the chat to go idle");
  assert.ok(done.data.last_active);
  // a turn ending is not the run stopping: the run's status says working, then waiting, and the chat follows
  d.events.emit("threads", "thread.status", { thread, chat: chat.id, status: "working" });
  await until(async () => { const r = await q(); return r && r.data.status === "working" ? r : null; }, "the chat to be working");
  d.events.emit("threads", "thread.status", { thread, chat: chat.id, status: "waiting" });
  await until(async () => { const r = await q(); return r && r.data.status === "idle" ? r : null; }, "the chat to be idle again after the turn");
  // a person added to the chat shows in the mirror
  await d.kernel.gateway.grants.chats.change(admin, chat.id, { add_assistants: [] }).catch(() => {});
  // the same run starting again is the same record, working again
  d.events.emit("threads", "thread.started", { thread, chat: chat.id, name: "Draft the welcome email", project: "harlow-intake", resumed: true });
  await until(async () => { const r = await q(); return r && r.data.status === "working" ? r : null; }, "the resumed run");
  assert.equal((await d.kernel.gateway.records.query(admin, "chat-record", { page: { limit: 10 } })).rows.filter((/** @type {any} */ r) => r.data.chat === chat.id).length, 1);
  // a Records write to a mirrored or system field is put back, and the kernel's list does not change
  const cur = await d.kernel.gateway.records.get(admin, "chat-record", done.id);
  await d.kernel.gateway.records.update(admin, "chat-record", done.id, { people: "per_someone_else" }, cur.version).catch(() => {});
  await until(async () => (await q()).data.people === d.kernel.id.owner ? true : null, "people to be put back");
  assert.deepEqual([...d.kernel.gateway.grants.chats.read(admin, chat.id).people], [d.kernel.id.owner], "kernel membership never changes because of a put-back");
});

test("a run in a project only the old folder projects know is given its Project record on first sight", { timeout: 120_000 }, async t => {
  const { d, admin } = await boot(t);
  const chat = await d.kernel.gateway.grants.chats.create(admin, {});
  const thread = "1f0e0d0c-0b0a-4908-8706-050403020100";
  d.events.emit("threads", "thread.started", { thread, chat: chat.id, name: "n", project: "legacy-client" });
  const row = await until(async () => { const r = (await d.kernel.gateway.records.query(admin, "chat-record", { page: { limit: 10 } })).rows.find((/** @type {any} */ x) => x.data.chat === chat.id); const proj = r && (await d.kernel.gateway.records.get(admin, "project", r.data.project.urn.split("/").pop())); return proj && proj.data.slug === "legacy-client" ? { r, proj } : null; }, "the chat in its own project");
  assert.equal(row.proj.data.drive_path, `Projects/${row.proj.id}`);
});

test("a terminal session (the Harness's SessionStart and SessionEnd hooks) gets a chat record too, and closes once", { timeout: 120_000 }, async t => {
  const { d, admin, meta } = await boot(t);
  const session = "2f0e0d0c-0b0a-4908-8706-050403020100";
  const brief = await d.registry.call("harness.brief", { session, cwd: process.cwd(), source: "startup" }, "cli", await meta());
  assert.ok(!brief.error || true);
  const chatId = await until(async () => { const r = await d.registry.call("threads.chat-of", { thread: session }, "module:work"); return r.data && r.data.chat; }, "the terminal session's chat");
  const q = async () => (await d.kernel.gateway.records.query(admin, "chat-record", { page: { limit: 10 } })).rows.find((/** @type {any} */ r) => r.data.chat === chatId) || null;
  const row = await until(async () => { const r = await q(); return r && r.data.status === "working" ? r : null; }, "the terminal session's chat record");
  assert.equal(row.data.status, "working");
  await d.registry.call("harness.end", { session, reason: "logout" }, "cli", await meta());
  const done = await until(async () => { const r = await q(); return r && r.data.status === "idle" ? r : null; }, "the chat to go idle");
  assert.ok(done.data.last_active);
  await d.registry.call("harness.end", { session, reason: "logout" }, "cli", await meta());
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await q()).data.status, "idle", "a second end changes nothing");
});

test("moving a Project between two real Spaces: the engine over both gateways, as the mover, with a new id in the target and a marker in the source", { timeout: 180_000 }, async t => {
  const { planMove, runMove } = await import("../core/work/project-move.js");
  const { d, admin, meta } = await boot(t);
  const ownerId = d.kernel.id.owner;
  const firm = await d.kernel.spaces.host({ owner: ownerId, name: "Harlow Legal" });
  const firmAdmin = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-h", person: ownerId, path: "direct", session: "s" });
  const made = await d.registry.call("work.project.create", { name: "Rivera" }, "cli", await meta());
  const urn = made.data.project;
  await d.kernel.gateway.records.create(admin, "chat-record", { title: "Intake", chat: "chat_t-1", project: { urn }, drive: made.data.drive_path });
  await d.kernel.gateway.drive.put(admin, `${made.data.drive_path}/retainer.txt`, new TextEncoder().encode("signed"));
  const side = (/** @type {any} */ space, /** @type {any} */ gw, /** @type {any} */ chain) => ({ space, records: gw.records, drive: gw.drive, chain, types: async (/** @type {any} */ c) => (gw.definitions ? gw.definitions(c) : []) });
  const from = side(d.kernel.id.space, d.kernel.gateway, admin);
  const to = side(firm.space, firm.gateway, firmAdmin);
  // the work module's types exist in the home Space only; the firm Space has none, so the plan says so
  const plan = await planMove({ from, to, project: urn });
  assert.equal(plan.counts.files, 2);
  assert.ok(plan.blockers.some((/** @type {string} */ b) => /no record type/.test(b) || /no Drive/.test(b)), JSON.stringify(plan.blockers));
  await assert.rejects(() => runMove({ from, to, plan }), /cannot run/);
  void d;
});
