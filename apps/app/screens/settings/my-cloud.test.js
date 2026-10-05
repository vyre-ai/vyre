import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { proofsAsked, runInputWith, plural, serversOf, blockersOf, canMove, cloudState, offerFor, planLines, reportLines, refusalLine, runInput, setupInput } from "./my-cloud.js";

const plan = { hash: "h1", counts: { records: { note: 3, reminder: 1, planner_alarm: 2 }, total: 6, chats: { chats: 2 } }, extend: [{ type: "contact", fields: ["job_title", "other_emails"] }], skippedTypes: [{ type: "legacy", why: "its link names a type that does not exist" }], sealed: ["a", "b"], blockers: [] };

test("my cloud: the plan reads line by line, and nothing the plan lacks is invented", () => {
  assert.deepEqual(planLines(plan), ["3 notes", "1 reminder", "2 planner alarms", "Your chats, with their history", "2 private fields, moved still sealed", "contact gains job title, other emails in My Cloud", "legacy stays in Personal: its link names a type that does not exist"]);
  assert.deepEqual(planLines({}), []);
  assert.deepEqual(planLines({ counts: { records: { note: 0 } } }), []);
});

test("my cloud: blockers hide the button, the box's words show, and one hash binds the approval", () => {
  assert.equal(canMove(plan), true);
  const blocked = { ...plan, blockers: ["the identity memory has facts not yet sealed: they are sealed first, then it can move"] };
  assert.equal(canMove(blocked), false);
  assert.deepEqual(blockersOf(blocked), blocked.blockers);
  assert.equal(canMove({ counts: {} }), false, "no hash, nothing to approve");
  assert.deepEqual(runInput(plan, "spc_cloud"), { to: "spc_cloud", plan_hash: "h1" });
});

test("my cloud: setup names the paired server and nothing is typed", () => {
  assert.deepEqual(setupInput({ id: "srv", name: "Studio mini" }), { name: "my-cloud", displayName: "My Cloud", home: { kind: "server", device: { id: "srv", name: "Studio mini", alwaysOn: true }, confirmed: true } });
});

test("my cloud: the report says what moved, what did not by name, and what Personal is now", () => {
  const done = reportLines({ upgraded: true, to: "spc_cloud", moved: { records: { note: 3 }, chats: { chats: 1 } }, notMoved: [], frozen: true });
  assert.deepEqual(done.moved, ["3 notes", "Your chats, with their history"]);
  assert.equal(done.after, "Personal now points to My Cloud and is read-only. Nothing was deleted.");
  const part = reportLines({ upgraded: true, moved: { records: { note: 2 } }, notMoved: [{ what: "chats: history", why: "no paired server to bring it back on" }], frozen: false, not_frozen_because: "something moved only in part" });
  assert.deepEqual(part.notMoved, ["chats: history: no paired server to bring it back on"]);
  assert.match(part.after, /Personal is unchanged/);
  assert.match(reportLines({ moved: {}, frozen: false, not_frozen_because: "My Cloud gave no receipt" }).after, /My Cloud gave no receipt/);
  assert.match(refusalLine({ code: "plan_changed" }), /Look at it again/);
  assert.equal(refusalLine({ code: "blocked", message: "This cannot start yet: x" }), "This cannot start yet: x");
});

test("my cloud: the offer follows the rows: setup, then move, then done", () => {
  const personal = { id: "spc_p", tier: "basic" }, cloud = { id: "spc_c", tier: "cloud", who: "personal" };
  assert.equal(offerFor(cloudState([personal]), true), "setup");
  assert.equal(offerFor(cloudState([personal]), false), "none", "no paired server, no button");
  assert.equal(offerFor(cloudState([personal, cloud]), false), "move");
  assert.equal(offerFor(cloudState([{ ...personal, upgraded_to: "spc_c" }, cloud]), true), "moved");
  assert.equal(offerFor(cloudState([{ id: "spc_t", tier: "cloud", displayName: "Northwind" }]), true), "none", "a team space is not My Cloud and there is no Personal row");
});

test("my cloud: only the paired servers spaces.servers lists can host it", () => {
  assert.deepEqual(serversOf({ servers: [{ id: "srv", name: "Studio mini", online: true }, { id: "", name: "x" }, { name: "no id" }] }), [{ id: "srv", name: "Studio mini" }]);
  assert.deepEqual(serversOf({ servers: [] }), []);
  assert.deepEqual(serversOf(null), []);
  assert.deepEqual(serversOf({ devices: [{ id: "a", name: "iPhone", kind: "server" }] }), [], "relay.devices.list rows are not paired servers");
});

test("my cloud: a move with private fields asks for two signatures, and the second call carries both", () => {
  const req = (op) => ({ op, space: "spc_home", fields: { x: 1 }, payload_hash: "h" });
  const both = proofsAsked({ needs_proof: true, request: req("grant.upgrade"), approve_request: req("task.seal_export") });
  assert.equal(both.move.op, "grant.upgrade");
  assert.equal(both.approve.op, "task.seal_export");
  const onlyApprove = proofsAsked({ needs_proof: true, approve_request: req("task.seal_export") });
  assert.equal(onlyApprove.move, null, "the move's proof was already given");
  assert.deepEqual(proofsAsked({ needs_proof: true, request: { op: "x" } }), { move: null, approve: null }, "a request that is not whole is not signed");
  assert.deepEqual(runInputWith({ hash: "h1" }, "spc_c", { signed: true }), { to: "spc_c", plan_hash: "h1", approve_proof: { signed: true } });
  assert.deepEqual(runInputWith({ hash: "h1" }, "spc_c", null), { to: "spc_c", plan_hash: "h1" });
});
