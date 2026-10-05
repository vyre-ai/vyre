// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerAt, rankByName, sealedChip, pick, sendIntent, runsOnLabel } from "./composer-model.js";

test("@, # and / open their pickers at the caret", () => {
  assert.equal(triggerAt("ask @ju", 7)?.kind, "person");
  assert.equal(triggerAt("see #north", 10)?.kind, "record");
  assert.equal(triggerAt("/mod", 4)?.kind, "command");
  assert.equal(triggerAt("mail a@b.com", 12), null);
  assert.equal(triggerAt("plain", 5), null);
});

test("people rank by prefix then by containing", () => {
  const list = [{ name: "kit" }, { name: "juno" }, { name: "Jules" }];
  assert.deepEqual(rankByName(list, "ju").map((p) => p.name), ["Jules", "juno"]);
  assert.deepEqual(rankByName(list, "x"), []);
});

test("a record with sealed fields says so on its chip", () => {
  assert.equal(sealedChip({ sealed: 1 }), "1 sealed field");
  assert.equal(sealedChip({ sealed: 3 }), "3 sealed fields");
  assert.equal(sealedChip({ sealed: 0 }), null);
});

test("picking a candidate writes it into the text", () => {
  const t = triggerAt("hi @ju", 6);
  assert.ok(t);
  assert.deepEqual(pick("hi @ju", t, "juno"), { text: "hi @juno ", caret: 9 });
  const r = triggerAt("#north", 6);
  assert.ok(r);
  assert.equal(pick("#north", r, "Northwind Bakery").text, '#"Northwind Bakery" ');
});

test("send is never disabled by a busy turn: it queues", () => {
  assert.deepEqual(sendIntent({ text: "go", state: "waiting" }), { send: true, queue: false, label: "Send" });
  assert.deepEqual(sendIntent({ text: "go", state: "working" }), { send: true, queue: true, label: "Queue" });
  assert.deepEqual(sendIntent({ text: "go", state: "asking" }).queue, true);
  assert.equal(sendIntent({ text: "  ", state: "working" }).send, false);
  assert.equal(sendIntent({ text: "", attachments: 1, state: "waiting" }).send, true);
});

test("runs-on labels", () => {
  assert.equal(runsOnLabel("mac"), "Runs on this Mac");
  assert.equal(runsOnLabel("server"), "Runs on the server");
});

import { mentionedAssistants, sendTargets } from "./composer-model.js";
const CHAT = [{ name: "kit", family: "assistant" }, { name: "juno", family: "assistant" }, { name: "chris", family: "person" }];

test("@mentions pick the assistants, once each, in order", () => {
  assert.deepEqual(mentionedAssistants("@juno and @kit please, @kit again, @chris look", CHAT), ["juno", "kit"]);
  assert.deepEqual(mentionedAssistants("mail kit@x.com", CHAT), []);
  assert.deepEqual(mentionedAssistants("@kitchen", CHAT), []);
});

test("two assistants (or ask all) make a fan-out; one or none does not", () => {
  assert.deepEqual(sendTargets({ text: "@kit @juno summarise", people: CHAT }), { to: ["kit", "juno"], fanout: true });
  assert.deepEqual(sendTargets({ text: "@kit run it", people: CHAT }), { to: ["kit"], fanout: false });
  assert.deepEqual(sendTargets({ text: "hello", people: CHAT }), { to: [], fanout: false });
  assert.deepEqual(sendTargets({ text: "summarise", askAll: true, people: CHAT }), { to: ["kit", "juno"], fanout: true });
});
