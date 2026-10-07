// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Prompts, PROMPTS_MIGRATION, MAX_CHARS, REPLACE_WARNING, scopeOf } from "./prompts.js";

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(PROMPTS_MIGRATION);
  let t = 1000;
  return new Prompts(db, () => t++);
}

const VYRE = "You run under Vyre for alex.";

test("versions increment per scope", () => {
  const p = fresh();
  assert.equal(p.current("assistant"), null);
  assert.equal(p.set("assistant", { text: "Be brief.", by: "alex" }).version, 1);
  const two = p.set("assistant", { text: "Be brief with alex.", note: "names" });
  assert.equal(two.version, 2);
  assert.equal(two.mode, "append");
  assert.equal(two.note, "names");
  assert.equal(p.set("agent:juno", { text: "You are juno." }).version, 1);
  assert.equal(p.current("assistant")?.text, "Be brief with alex.");
});

test("setting the same text and mode makes no version", () => {
  const p = fresh();
  p.set("project:northwind-bakery", { text: "Bakery orders." });
  const again = p.set("project:northwind-bakery", { text: "Bakery orders." });
  assert.equal(again.unchanged, true);
  assert.equal(again.version, 1);
  assert.equal(p.history("project:northwind-bakery").length, 1);
  // same text, other mode, is an edit
  assert.equal(p.set("project:northwind-bakery", { text: "Bakery orders.", mode: "replace" }).version, 2);
});

test("history is newest first and capped", () => {
  const p = fresh();
  for (let i = 1; i <= 205; i++) p.set("agent:kit", { text: `v${i}` });
  const h = p.history("agent:kit");
  assert.equal(h.length, 20);
  assert.deepEqual(h.slice(0, 3).map(r => r.version), [205, 204, 203]);
  assert.equal(p.history("agent:kit", 3).length, 3);
  assert.equal(p.history("agent:kit", 1000).length, 200);
});

test("revert makes a new version with the old text and mode", () => {
  const p = fresh();
  p.set("assistant", { text: "Good prompt." });
  p.set("assistant", { text: "Bad edit.", mode: "replace" });
  const r = p.revert("assistant", 1, "alex");
  assert.equal(r.version, 3);
  assert.equal(r.text, "Good prompt.");
  assert.equal(r.mode, "append");
  assert.equal(r.by, "alex");
  assert.equal(r.note, "revert to v1");
  assert.equal(p.history("assistant").length, 3);
  assert.throws(() => p.revert("assistant", 9, "alex"), /no prompt version 9/);
});

test("compose: a plain thread uses the assistant level after Vyre's text", () => {
  const p = fresh();
  assert.deepEqual(p.compose(), { mode: "append", text: "", parts: [] });
  assert.deepEqual(p.compose({ append: VYRE }), { mode: "append", text: VYRE, parts: [] });
  p.set("assistant", { text: "Assistant words." });
  p.set("agent:juno", { text: "Juno words." });
  const c = p.compose({ append: VYRE });
  assert.equal(c.mode, "append");
  assert.equal(c.text, `${VYRE}\n\nAssistant words.`);
  assert.deepEqual(c.parts, [{ scope: "assistant", version: 1, mode: "append" }]);
  assert.equal(c.warning, undefined);
});

test("compose: the assistant agent uses the assistant level, another agent its own", () => {
  const p = fresh();
  p.set("assistant", { text: "Assistant words." });
  p.set("agent:juno", { text: "Juno words." });
  assert.equal(p.compose({ agent: "juno", agentKind: "assistant", append: VYRE }).text, `${VYRE}\n\nAssistant words.`);
  const c = p.compose({ agent: "juno", agentKind: "worker", append: VYRE });
  assert.equal(c.text, `${VYRE}\n\nJuno words.`);
  assert.deepEqual(c.parts.map(x => x.scope), ["agent:juno"]);
});

test("compose: project text comes last, general to specific", () => {
  const p = fresh();
  p.set("agent:kit", { text: "Kit words." });
  p.set("project:harlow-legal", { text: "Harlow Legal words." });
  const c = p.compose({ agent: "kit", project: "harlow-legal", append: VYRE });
  assert.equal(c.text, `${VYRE}\n\nKit words.\n\nHarlow Legal words.`);
  assert.deepEqual(c.parts.map(x => x.scope), ["agent:kit", "project:harlow-legal"]);
  // plain thread in a project: assistant then project
  p.set("assistant", { text: "Assistant words." });
  assert.equal(p.compose({ project: "harlow-legal" }).text, "Assistant words.\n\nHarlow Legal words.");
});

test("compose: replace at agent level keeps a project append and Vyre's text last", () => {
  const p = fresh();
  p.set("assistant", { text: "Assistant words." });
  p.set("agent:kit", { text: "Only kit.", mode: "replace" });
  p.set("project:harlow-legal", { text: "Harlow Legal words." });
  const c = p.compose({ agent: "kit", project: "harlow-legal", append: VYRE });
  assert.equal(c.mode, "replace");
  assert.equal(c.text, `Only kit.\n\nHarlow Legal words.\n\n${VYRE}`);
  assert.deepEqual(c.parts, [{ scope: "agent:kit", version: 1, mode: "replace" }, { scope: "project:harlow-legal", version: 1, mode: "append" }]);
  assert.equal(c.warning, REPLACE_WARNING);
});

test("compose: replace at project overrides an agent replace", () => {
  const p = fresh();
  p.set("agent:kit", { text: "Only kit.", mode: "replace" });
  p.set("project:harlow-legal", { text: "Only Harlow Legal.", mode: "replace" });
  const c = p.compose({ agent: "kit", project: "harlow-legal", append: VYRE });
  assert.equal(c.text, `Only Harlow Legal.\n\n${VYRE}`);
  assert.deepEqual(c.parts.map(x => x.scope), ["project:harlow-legal"]);
  assert.equal(c.warning, REPLACE_WARNING);
});

test("compose: an empty (cleared) level is ignored", () => {
  const p = fresh();
  p.set("assistant", { text: "Assistant words." });
  const cleared = p.set("assistant", { text: "" });
  assert.equal(cleared.version, 2);
  assert.equal(p.current("assistant")?.text, "");
  assert.deepEqual(p.compose({ append: VYRE }), { mode: "append", text: VYRE, parts: [] });
  // a cleared project does not hide an agent replace
  p.set("agent:juno", { text: "Only juno.", mode: "replace" });
  p.set("project:northwind-bakery", { text: "" });
  assert.equal(p.compose({ agent: "juno", project: "northwind-bakery", append: VYRE }).text, `Only juno.\n\n${VYRE}`);
});

test("set refuses secrets, long text, bad modes and empty replaces", () => {
  const p = fresh();
  // built from pieces so this file holds nothing shaped like a key
  const value = ["q7Rz", "Lm2P", "x9Vt", "K4wB", "n8Hs"].join("");
  assert.throws(() => p.set("assistant", { text: `use api_key=${value} for the bakery` }), /looks like it contains a secret/);
  assert.equal(p.current("assistant"), null);
  assert.throws(() => p.set("assistant", { text: "a".repeat(MAX_CHARS + 1) }), /limit is 20000/);
  assert.equal(p.set("assistant", { text: "a".repeat(MAX_CHARS) }).version, 1);
  assert.throws(() => p.set("assistant", { text: "x", mode: /** @type {any} */ ("prepend") }), /mode/);
  assert.throws(() => p.set("assistant", { text: "  ", mode: "replace" }), /cannot be empty/);
});

test("bad scopes are refused", () => {
  assert.equal(scopeOf("assistant"), "assistant");
  assert.equal(scopeOf("capsule"), "capsule");
  assert.equal(scopeOf("agent:juno"), "agent:juno");
  assert.equal(scopeOf("project:harlow-legal.v2_x"), "project:harlow-legal.v2_x");
  for (const bad of ["", "assistants", "agent:", "agent:a b", "project:../x/y", "team:kit", `agent:${"k".repeat(65)}`, "agent:kit;drop"]) {
    assert.throws(() => scopeOf(bad), /prompt scope/, bad);
  }
  const p = fresh();
  assert.throws(() => p.set("agent:", { text: "x" }), /prompt scope/);
  assert.throws(() => p.compose({ agent: "bad name" }), /prompt scope/);
});
