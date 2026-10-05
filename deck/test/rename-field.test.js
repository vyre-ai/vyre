// @ts-check
// Rename in place (js/rename-field.js, #65): the pencil opens a field, Enter keeps, Esc leaves, an error stays in the field, and the tool is the one for the device's kind.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

async function load() {
  const { install, $, text } = await import("./fake-dom.js");
  install();
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
  /** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
  const mod = await import("../js/rename-field.js");
  return { ...mod, $, text };
}
const key = (/** @type {string} */ k) => Object.assign(new Event("keydown"), { key: k, preventDefault() {} });

test("rename: the pencil opens a field with the name, Enter saves and the new name shows", async () => {
  const { renameField, $, text } = await load();
  const saved = /** @type {string[]} */ ([]);
  const f = renameField({ name: "Aina's iPhone", save: async n => { saved.push(n); return {}; } });
  assert.equal(text($(f, ".rn-name")), "Aina's iPhone");
  $(f, ".rn-edit").click();
  const input = $(f, ".rn-in");
  assert.equal(input.value, "Aina's iPhone");
  input.value = "  Phone  ";
  input.dispatchEvent(key("Enter"));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(saved, ["Phone"]);
  assert.equal(text($(f, ".rn-name")), "Phone");
  assert.equal($(f, ".rn-in"), null);
});

test("rename: Esc leaves the name alone; an empty or 65-character name is refused; an error from your server stays in the field", async () => {
  const { renameField, $, text } = await load();
  let calls = 0;
  const f = renameField({ name: "Mac mini", save: async () => { calls++; return { error: { message: "No such Mac." } }; } });
  $(f, ".rn-edit").click();
  $(f, ".rn-in").dispatchEvent(key("Escape"));
  assert.equal(text($(f, ".rn-name")), "Mac mini");
  $(f, ".rn-edit").click();
  $(f, ".rn-in").value = "   ";
  $(f, ".rn-in").dispatchEvent(key("Enter"));
  assert.match(text($(f, ".rn-msg")), /one to 64/);
  $(f, ".rn-in").value = "x".repeat(65);
  $(f, ".rn-in").dispatchEvent(key("Enter"));
  assert.equal(calls, 0, "nothing sent");
  $(f, ".rn-in").value = "Studio";
  $(f, ".rn-in").dispatchEvent(key("Enter"));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls, 1);
  assert.match(text($(f, ".rn-msg")), /No such Mac/);
  assert.ok($(f, ".rn-in"), "still editing");
  $(f, ".rn-in").dispatchEvent(key("Escape"));
  f.setName("Studio");
  assert.equal(text($(f, ".rn-name")), "Studio", "a rename seen elsewhere changes it here");
});

test("rename: the tool and input for each kind of device", async () => {
  const { renameCall } = await load();
  assert.deepEqual(renameCall("relay", "d1", "Phone"), { tool: "relay.devices.rename", input: { id: "d1", name: "Phone" } });
  assert.deepEqual(renameCall("server", "server", "Home"), { tool: "system.rename", input: { name: "Home" } });
  assert.deepEqual(renameCall("computer", "c1", "Build"), { tool: "computers.rename", input: { computer: "c1", name: "Build" } });
});
