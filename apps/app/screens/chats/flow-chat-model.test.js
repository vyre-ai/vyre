// @ts-check
// Flow chats: wakes grouped by Flow, dividers, collapsing, the reply target, and what stays in the main Chat list.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const D = Date.UTC(2026, 9, 13, 10, 14);
const w = (id, flow, run, step, o = {}) => ({ id, agent: "refunds", name: "refunds", status: "idle", started: D, last: D, origin: { flow, run, step, record_name: "Refund for Jane Doe", flow_name: "Refund request", step_name: "refunds agent", run_no: run.slice(-2), approver: "Dana", ...o.origin }, ...o.row });
const rows = [
  w("t3", "f1", "run_43", "2", { row: { started: D + 7200_000, last: D + 7200_000, status: "waiting", asks: 1 } }),
  w("t1", "f1", "run_41", "2", { row: { started: D - 86400_000, last: D - 86400_000 } }),
  w("t2", "f1", "run_42", "2", { row: { started: D, last: D, status: "stopped", stopped_reason: "exited 1" } }),
  w("t9", "f2", "run_7", "1", { origin: { flow_name: "Welcome email" }, row: { name: "Flow: Draft welcome - Welcome email", last: D - 5 } }),
  { id: "x", agent: "refunds", status: "idle", purpose: "agent" },
  { id: "y", agent: "refunds", status: "idle", origin: "capsule" },
];

test("wakes group by Flow, oldest first, one chat per Flow", { skip: !strip }, async () => {
  const m = await import("./flow-chat-model.ts");
  const c = m.flowChats(rows, { zone: "UTC" });
  assert.deepEqual(c.map((x) => x.id), ["f1", "f2"]);
  assert.deepEqual(c[0].sections.map((s) => s.thread), ["t1", "t2", "t3"]);
  assert.equal(c[0].runs, 3);
  assert.equal(c[0].needsYou, 1);
  assert.equal(c[0].lastState, "waiting");
  assert.equal(c[1].title, "Flow: Draft welcome - Welcome email");
  assert.equal(c[0].title, "Flow: refunds agent - Refund request");
});

test("divider reads run, record, step, time and state", { skip: !strip }, async () => {
  const m = await import("./flow-chat-model.ts");
  const s = m.flowChats(rows, { zone: "UTC" })[0].sections;
  assert.equal(s[1].divider, "Run 42 · Refund for Jane Doe · Step 2, refunds agent · 10:14 · Failed");
});

test("older runs start collapsed; the newest and any waiting on you stay open; a person's choice wins", { skip: !strip }, async () => {
  const m = await import("./flow-chat-model.ts");
  assert.deepEqual(m.flowChats(rows)[0].sections.map((s) => s.collapsed), [true, true, false]);
  const o = m.flowChats(rows, { open: new Set(["t1"]), shut: new Set(["t3"]) })[0].sections;
  assert.deepEqual(o.map((s) => s.collapsed), [false, true, true]);
});

test("the header says where it came from, whose access, and the run to open", { skip: !strip }, async () => {
  const m = await import("./flow-chat-model.ts");
  const h = m.wakeHeader(m.markerOf(rows[0]));
  assert.equal(h.where, "Flow Refund request, run 43, step refunds agent");
  assert.equal(h.access, "Runs with Dana's access");
  assert.equal(h.openRun, "/u/flows/f1/runs/run_43");
  assert.equal(m.wakeHeader({ flow: "f", run: "run_1", step: "1" }).access, null);
});

test("only a waiting wake stays in the main list; threads with no Flow origin always do", { skip: !strip }, async () => {
  const m = await import("./flow-chat-model.ts");
  assert.deepEqual(rows.filter(m.inMainList).map((r) => r.id), ["t3", "x", "y"]);
});

test("reply goes to the agent, or to one run", { skip: !strip }, async () => {
  const m = await import("./flow-chat-model.ts");
  const c = m.flowChats(rows, { zone: "UTC" })[0];
  assert.equal(m.replyTarget(c, null).thread, null);
  assert.deepEqual(m.replyTarget(c, c.sections[1]), { thread: "t2", label: "Replying to Run 42 · Refund for Jane Doe" });
  assert.match(m.flowChatSub(c, D + 3 * 3600_000), /^3 runs · Last: waiting on you · /);
  assert.deepEqual(m.flowChatsOf(rows, "nobody"), []);
});

test("the Flow origin is row.flow_origin; a string origin is the launch surface and no Flow", { skip: !strip }, async () => {
  const m = await import("./flow-chat-model.ts");
  const r = { id: "z", agent: "a", origin: "capsule", flow_origin: { flow: "f9", run: "run_9", step: "1", flow_name: "Intake", step_name: "draft", approver: "Dana" } };
  assert.equal(m.markerOf(r)?.flow, "f9");
  assert.equal(m.markerOf({ id: "q", origin: "capsule", flow_origin: null }), null);
  assert.deepEqual(m.flowChats([r])[0].title, "Flow: draft - Intake");
});
