import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { plural, serversOf, blockersOf, canMove, cloudState, offerFor, planLines, reportLines, refusalLine, runInput, setupInput } from "./my-cloud.js";

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

test("my cloud: only paired servers can host it", () => {
  assert.deepEqual(serversOf({ devices: [{ id: "a", name: "iPhone", kind: "app" }, { id: "srv", name: "Studio mini", kind: "server" }] }), [{ id: "srv", name: "Studio mini" }]);
  assert.deepEqual(serversOf(null), []);
});

test("my cloud: plurals follow a small rule", () => {
  assert.deepEqual(["note", "company", "category", "address", "box", "match", "day", "planner alarm"].map(plural), ["notes", "companies", "categories", "addresses", "boxes", "matches", "days", "planner alarms"]);
  assert.deepEqual(planLines({ counts: { records: { company: 2, category: 1, address: 3 } } }), ["2 companies", "1 category", "3 addresses"]);
});
