// @ts-check
// A hand-off to a teammate is a row in the asker's conversation, and the teammate's steps are nested under it (SPEC-0.3.0 11.1 and 11.2, team/0.3/IFACE-activity.md). On a real daemon with the fake
// session driver: a session asks a teammate; the frames the stream holds for that session say so, in order, with the report.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { call } from "../daemon/client.js";
import { open as openStore } from "../store/index.js";
import { paths } from "../config/index.js";
import { boot, until, realSession } from "../team/team-fixture.js";
import { validate, HANDOFF_STATES } from "./protocol.js";

/** The frames the stream holds for a session, oldest first. @param {string} root @param {string} session */
const framesOf = (root, session) => {
  const db = openStore(paths(root).db);
  try { return db.prepare("SELECT json FROM stream_frames WHERE session = ? ORDER BY cur").all(session).map((/** @type {any} */ r) => JSON.parse(r.json)); } finally { db.close(); }
};

test("handoff frames: validated, with a state from the list, a text that is cut, and a via that is an id", () => {
  const base = { v: 1, type: "chat.handoff", id: "f1", session: "s1", cur: 1, time: 1, turn: null, data: { request: "r_1", to: { agent: "kit-billing", role: "kit" }, state: "queued", text: "chase the invoices" } };
  assert.deepEqual(validate(base), { ok: true });
  for (const state of HANDOFF_STATES) assert.equal(validate({ ...base, data: { ...base.data, state } }).ok, true, state);
  assert.equal(validate({ ...base, data: { ...base.data, state: "waiting" } }).ok, false);
  assert.equal(validate({ ...base, data: { ...base.data, text: "x".repeat(301) } }).ok, false);
  assert.equal(validate({ ...base, data: { ...base.data, result: "x".repeat(601) } }).ok, false);
  assert.equal(validate({ ...base, data: { ...base.data, to: { agent: "kit" } } }).ok, false);
  assert.equal(validate({ ...base, type: "chat.tool-started", data: { tool_id: "t", tool: "Bash", kind: "shell", summary: "ls", via: "r_1" } }).ok, true);
  assert.equal(validate({ ...base, type: "chat.tool-started", data: { tool_id: "t", tool: "Bash", kind: "shell", summary: "ls", via: "" } }).ok, false);
});

test("a session asks a teammate: the asker's log gets queued, running (with the teammate's session) and done (with the report), and the teammate's steps carry via", { timeout: 120_000 }, async t => {
  const { tool, root, project, launches } = await boot(t);
  await tool("team.add", { project: project.record, role: "billing", brief: "invoices" });
  const { thread, session } = await realSession(root, tool, launches, project.slug);
  const ask = await call("team.ask", { to: "billing", project: project.record, wait: true, text: 'vyre team.done {"result":"Three invoices are overdue: Northwind, Oakline, Brightwell.","notes":"unchanged","reason":"test"}' }, { root, caller: "mcp", session, timeout: 60_000 });
  assert.equal(ask.error, undefined, JSON.stringify(ask.error));
  assert.equal(ask.data.state, "done");

  const frames = await until(async () => { const f = framesOf(root, thread); const d = f.filter(x => x.type === "chat.handoff"); return d.some(x => x.data.state === "done") ? f : null; }, "the hand-off to reach done in the asker's log");
  const rows = frames.filter(x => x.type === "chat.handoff");
  assert.deepEqual(rows.map(x => x.data.state).filter((s, i, a) => a.indexOf(s) === i), ["queued", "running", "done"], JSON.stringify(rows.map(x => x.data.state)));
  assert.ok(rows.every(x => x.data.request === ask.data.request && x.data.to.role === "billing" && x.data.to.agent.startsWith("billing-")), "one row, by request");
  const running = rows.find(x => x.data.thread);
  assert.ok(running && typeof running.data.thread === "string", "the row names the teammate's own session");
  const done = rows[rows.length - 1];
  assert.match(done.data.result, /Three invoices are overdue/);
  assert.match(done.data.text, /team\.done/, "what was asked");
  assert.deepEqual(frames.map(x => x.cur), frames.map((_, i) => i + 1), "the log has no gap");
  for (const f of frames) assert.equal(validate(f).ok, true, `${f.type}: ${JSON.stringify(validate(f))}`);
  // the teammate's steps, if the fake driver made any, are nested and are the teammate's
  for (const f of frames.filter(x => x.data && x.data.via)) {
    assert.equal(f.data.via, ask.data.request);
    assert.match(String(f.author), /^assistant:billing-/);
    assert.ok(["tool-started", "tool-finished", "file-changed"].includes(f.type.slice(5)), f.type);
  }
});

test("a person's own ask, from a terminal (no session), makes no row anywhere", { timeout: 120_000 }, async t => {
  const { tool, root, project } = await boot(t);
  await tool("team.add", { project: project.record, role: "qa" });
  const ask = await tool("team.ask", { to: "qa", project: project.record, wait: true, text: 'vyre team.done {"result":"ok","notes":"unchanged","reason":"test"}' });
  assert.equal(ask.state, "done");
  const db = openStore(paths(root).db);
  const n = /** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM stream_frames WHERE json LIKE '%chat.handoff%'").get()).n;
  db.close();
  assert.equal(n, 0);
});

test("the teammate's tool steps are appended to the asker's log with via and the teammate as author; its words are not, and once the row ends nothing more is added", async () => {
  const { Logs } = await import("./log.js");
  const { createActivity } = await import("./activity.js");
  const logs = new Logs({});
  const activity = createActivity({ ctx: { log() {} }, logs, groups: null });
  const ev = (/** @type {string} */ type, /** @type {any} */ payload, /** @type {any} */ more = {}) => ({ type, payload, ...more });
  activity.onSummon(ev("summon.queued", { request: "r_9", teammate: "kit-billing", project: "billing", reply_to: "thr_juno", role: "kit", text: "chase invoices" }));
  activity.onSummon(ev("summon.started", { request: "r_9", teammate: "kit-billing", project: "billing", reply_to: "thr_juno" }));
  activity.onSummon(ev("summon.thread", { request: "r_9", teammate: "kit-billing", project: "billing", thread: "thr_kit", reply_to: "thr_juno" }));
  const te = (/** @type {string} */ type, /** @type {any} */ payload) => ({ type, id: 1, thread: "thr_kit", payload, time: 1 });
  activity.onThread(te("thread.text", { message: "m1", text: "I will look.", done: true }));
  activity.onThread(te("thread.tool", { id: "tu_1", call: "tu_1", tool: "Read", phase: "started", summary: "Read invoices/overdue.csv" }));
  activity.onThread(te("thread.tool", { id: "tu_1", call: "tu_1", phase: "done", error: false }));
  activity.onSummon(ev("summon.finished", { request: "r_9", teammate: "kit-billing", project: "billing", status: "done", reply_to: "thr_juno", result: "Three are overdue." }));
  activity.onThread(te("thread.tool", { id: "tu_2", call: "tu_2", tool: "Read", phase: "started", summary: "late" }));
  const log = logs.get("thr_juno");
  const frames = log.read(0).map((/** @type {any} */ f) => [f.type, f.data.state ?? f.data.via ?? "", f.author ?? ""]);
  assert.deepEqual(frames, [
    ["chat.handoff", "queued", ""], ["chat.handoff", "running", ""], ["chat.handoff", "running", ""],
    ["chat.tool-started", "r_9", "assistant:kit-billing"], ["chat.tool-finished", "r_9", "assistant:kit-billing"],
    ["chat.handoff", "done", ""],
  ]);
  const last = log.read(0).filter((/** @type {any} */ f) => f.type === "chat.handoff").pop();
  assert.deepEqual([last.data.result, last.data.thread, last.data.to.name], ["Three are overdue.", "thr_kit", "kit"]);
});
