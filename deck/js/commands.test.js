// @ts-check
// Find's command grammar, which the Mac Lumen and the native apps share.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, rankSessions, plan } from "./commands.js";

const agents = [{ name: "juno" }, { name: "kit" }];
const sessions = [
  { id: "s1", name: "Harlow intake form" },
  { id: "s2", name: "Northwind invoices" },
  { id: "s3", name: "intake" },
  { id: "s4", name: "Weekly planning" },
];
const world = { agents, sessions };

test("commands: @agent asks that agent, and an unknown @name is just a question", () => {
  assert.deepEqual(parseCommand("@Kit write the ad for Northwind", world), { kind: "agent", agent: "kit", text: "write the ad for Northwind" });
  assert.deepEqual(parseCommand("@dana hello", world), { kind: "ask", text: "@dana hello" });
  assert.equal(parseCommand("@kit", world).kind, "ask", "a bare mention has nothing to say");
});

test("commands: tell me when, tell/ask ... to, and watch find their session", () => {
  const w = /** @type {any} */ (parseCommand("tell me when the intake thread is done", world));
  assert.equal(w.kind, "watch");
  assert.equal(w.until, "finished");
  assert.equal(w.candidates[0].id, "s3", "an exact name first");
  assert.equal(/** @type {any} */ (parseCommand("notify me when intake asks", world)).until, "asks");
  const d = /** @type {any} */ (parseCommand("Tell northwind invoices to check the March total", world));
  assert.deepEqual([d.kind, d.text, d.candidates[0].id], ["drive", "check the March total", "s2"]);
  const m = /** @type {any} */ (parseCommand("watch weekly planning and tell me", world));
  assert.deepEqual([m.kind, m.until, m.candidates[0].id], ["watch", "either", "s4"]);
});

test("commands: no matching session leaves the words for the assistant", () => {
  assert.deepEqual(parseCommand("tell the bakery site to deploy", world), { kind: "ask", text: "tell the bakery site to deploy" });
  assert.deepEqual(parseCommand("what is left this week?", world), { kind: "ask", text: "what is left this week?" });
});

test("commands: sessions rank exact, then punctuation dropped, then words, then letters in order", () => {
  const rows = [{ id: "a", name: "Harlow-site rebuild" }, { id: "b", name: "harlow site" }, { id: "c", name: "Harlow site" }, { id: "d", name: "harbour log" }];
  assert.deepEqual(rankSessions("harlow site", rows).map(r => r.id), ["b", "c", "a"]);
  assert.deepEqual(rankSessions("harlowsite", rows).map(r => r.id), ["b", "c", "a"]);
  assert.deepEqual(rankSessions("hbrlg", rows).map(r => r.id), ["d"]);
  assert.deepEqual(rankSessions("", rows), []);
});

test("commands: the line under your server says what Enter does", () => {
  assert.equal(plan(parseCommand("@kit hi", world), "", "juno"), "Enter asks kit.");
  assert.equal(plan(parseCommand("tell intake to add a phone field", world), "intake", "juno"), "Enter types into intake, then watches it.");
  assert.equal(plan(parseCommand("hello", world), "", "juno"), "Enter asks juno.");
});
