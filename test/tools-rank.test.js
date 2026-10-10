// @ts-check
// lib/tools-rank: the asks a tool answers are the evidence. A word only one family of tools is asked with decides, an ask resembling a whole bank beats a stray word, and fusing lists puts first the
// tool several views agree on. Pure: tiny tools and asks written for the test, no catalog.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { features, buildAskModel, rankAsks, fuse } from "../lib/tools-rank.js";

const model = buildAskModel([
  { name: "mail_send", asks: ["send an email to the client", "email Mr Alvarez the letter", "write to the court clerk by email"] },
  { name: "comms_text", asks: ["text Dana that the signing moved", "send a text message to the client", "sms the witness about tomorrow"] },
  { name: "calendar_add", asks: ["put the hearing on my calendar", "book a meeting with Carla at 3", "add the deposition to the diary"] },
]);
const top = (/** @type {[string, number][]} */ l) => l[0][0];

test("features are stems and word pairs, so a phrase counts as more than its words", () => {
  const f = features("Sending the texts");
  assert.ok(f.includes("send") && f.includes("text"));
  assert.ok(f.some((x) => x.includes("_")), "a pair");
});

test("a word one family is asked with decides: text goes to the text tool even with a date in it, email to mail", () => {
  assert.equal(top(rankAsks(model, "text Dana the signing is at 10 tomorrow").bayes), "comms_text");
  assert.equal(top(rankAsks(model, "text Dana the signing is at 10 tomorrow").centroid), "comms_text");
  assert.equal(top(rankAsks(model, "email the clerk about the hearing").bayes), "mail_send");
  assert.equal(top(rankAsks(model, "put Friday's hearing on my calendar").centroid), "calendar_add");
});

test("every tool is ranked, best first, and the same query gives the same lists every time", () => {
  const a = rankAsks(model, "send something to the client"), b = rankAsks(model, "send something to the client");
  assert.deepEqual(a, b);
  assert.equal(a.centroid.length, 3);
  assert.equal(a.bayes.length, 3);
  assert.ok(a.centroid[0][1] >= a.centroid[1][1] && a.bayes[0][1] >= a.bayes[1][1]);
});

test("a query of words nobody was asked with ranks without throwing", () => {
  const r = rankAsks(model, "zzzz qqqq");
  assert.equal(r.centroid.length, 3);
  assert.equal(r.bayes.length, 3);
});

test("fusion puts first the tool several lists put high, and reports each list's rank for it", () => {
  const l1 = [{ name: "a" }, { name: "b" }, { name: "c" }], l2 = [{ name: "b" }, { name: "a" }, { name: "c" }], l3 = [{ name: "b" }, { name: "c" }, { name: "a" }];
  const f = fuse([l1, l2, l3]);
  assert.equal(f[0].name, "b");
  assert.deepEqual(f.find((x) => x.name === "b")?.ranks, [1, 0, 0]);
  assert.equal(fuse([[{ name: "x" }], [{ name: "y" }]], { depth: 1 }).length, 2);
  assert.deepEqual(fuse([[{ name: "x" }], [{ name: "y" }, { name: "x" }]], { depth: 1 }).find((e) => e.name === "x")?.ranks, [0, -1], "beyond the depth counts as absent");
});
