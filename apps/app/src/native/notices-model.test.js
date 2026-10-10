// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalNotices, doneNotices, isWorking, sharedLoop } from "./notices-model.js";

const PENDING = { approvals: [{ id: "a1", group: "gp_1", line: "Send an email to Northwind" }, { id: "a2", group: "gp_1" }, { id: "s1", title: "Turn a rule off" }], groups: [{ id: "gp_1", size: 2, line: "An assistant (kit) wants to run 2 calls of mail.send: Northwind, Oakline" }] };

test("a waiting group is one notice, a single card another, each told once", () => {
  const a = approvalNotices(new Set(), PENDING);
  assert.deepEqual(a.notices.map((n) => [n.title, n.route]), [["2 calls wait for your yes", "/u/now"], ["Waiting for your approval", "/u/now"]]);
  assert.match(a.notices[0].body ?? "", /kit/);
  const b = approvalNotices(a.seen, PENDING);
  assert.deepEqual(b.notices, [], "told once");
  const grown = approvalNotices(a.seen, { ...PENDING, groups: [{ id: "gp_1", size: 3, line: "x" }] });
  assert.equal(grown.notices.length, 1, "a group that grew is worth telling again");
  assert.deepEqual(approvalNotices(new Set(), null).notices, []);
});

test("a session that was working and is not now is done, once, and not when the person has it open", () => {
  const was = new Map([["t1", "running"], ["t2", "running"], ["t3", "idle"]]);
  const threads = [{ id: "t1", name: "juno", status: "idle", last: 5 }, { id: "t2", name: "kit", status: "running" }, { id: "t3", name: "old", status: "idle" }];
  const r = doneNotices(was, threads);
  assert.deepEqual(r.notices.map((n) => [n.title, n.route]), [["juno is done", "/session/t1"]]);
  assert.deepEqual(doneNotices(r.was, threads).notices, [], "the next look has nothing new");
  assert.deepEqual(doneNotices(was, threads, { openId: "t1" }).notices, []);
  const failed = doneNotices(new Map([["t1", "working"]]), [{ id: "t1", name: "juno", status: "failed" }]);
  assert.equal(failed.notices[0].title, "juno stopped");
  assert.equal(isWorking("Running"), true);
  assert.equal(isWorking("idle"), false);
});

test("the notice loop is one for any number of askers: the screen and the headless task of the Android service never run two (that would tell the person everything twice)", () => {
  let started = 0, stopped = 0;
  const loop = sharedLoop(() => { started++; return () => { stopped++; }; });
  const screen = loop(undefined), headless = loop(undefined);
  assert.deepEqual([started, stopped], [1, 0], "two askers, one loop");
  screen(); screen();
  assert.deepEqual([started, stopped], [1, 0], "one asker leaving (twice over) keeps it for the other");
  headless();
  assert.deepEqual([started, stopped], [1, 1], "the last one leaving stops it");
  const again = loop(undefined); again();
  assert.deepEqual([started, stopped], [2, 2], "and it can start again");
});
