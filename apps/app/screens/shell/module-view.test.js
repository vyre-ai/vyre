// @ts-check
// What the app does with a module view's frames and answers (module-view.js): inputs carry ids and typed values, never tool names; an answer maps to one effect; a card dropped on a column asks
// for the module's move only when the module declared one. The fixture is the cards module's board (core/views/views.test.js).
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { emailOf, getInput, actInput, missingFields, initialValues, outcome, moveAction, barHeights, actionsOf } from "./module-view.js";

const card = { id: "c1", title: "Write brief", actions: [{ id: "move", title: "Move" }, { id: "nudge", title: "Nudge", outward: true }] };

test("module view: the inputs name the module's view and ids, and carry a form's proof only when given", () => {
  assert.deepEqual(getInput({ module: "cards", view: "board", q: "x" }), { module: "cards", command: "board", q: "x" });
  assert.deepEqual(getInput({ module: "cards", view: "board", id: "c1" }), { module: "cards", command: "board", id: "c1", view: "detail" });
  const a = actInput({ module: "cards", view: "board", action: "move", id: "c1", column: "doing" });
  assert.deepEqual(a, { module: "cards", command: "board", action: "move", id: "c1", column: "doing" });
  assert.ok(!JSON.stringify(a).includes("tool"), "no tool name leaves the app");
  assert.deepEqual(actInput({ module: "cards", view: "board", action: "submit", form: "nudge", fields: { note: "hi" }, asked: { hash: "h", token: "t" } }).asked, { hash: "h", token: "t" });
});

test("module view: a form lists what is still missing, and starts with empty values", () => {
  const form = { fields: [{ name: "note", label: "Note", type: "multiline", required: true }, { name: "tag", label: "Tag", type: "text" }] };
  assert.deepEqual(missingFields(form, { note: "  ", tag: "" }), ["Note"]);
  assert.deepEqual(missingFields(form, { note: "x" }), []);
  assert.deepEqual(initialValues(form), { note: "", tag: "" });
  assert.deepEqual(initialValues({ fields: [{ name: "email", type: "text", default: "jo@example.com" }, { name: "name", type: "text", default: "" }] }), { email: "jo@example.com", name: "" }, "a default the server gave starts the field");
});

test("module view: every answer of the server becomes one effect", () => {
  assert.deepEqual(outcome({ kind: "done", said: "Moved." }), { effect: "reload", said: "Moved." });
  assert.deepEqual(outcome({ kind: "done", effect: { open: "https://x.example" } }), { effect: "open", url: "https://x.example" });
  assert.deepEqual(outcome({ kind: "done", effect: { copy: "abc" } }), { effect: "copy", text: "abc" });
  const p = outcome({ kind: "preview", title: "Send", words: [{ label: "note", value: "hi" }], hash: "h", token: "t" });
  assert.deepEqual([p.effect, p.asked], ["preview", { hash: "h", token: "t" }]);
  assert.equal(outcome({ kind: "view", frame: { kind: "form" } }).effect, "frame");
  assert.equal(outcome({ kind: "held", message: "OK?" }).effect, "held");
  assert.equal(outcome({ kind: "needs", message: "Key" }).effect, "needs");
  assert.equal(outcome({ kind: "error", message: "No" }).effect, "error");
  assert.equal(outcome(null).effect, "error");
});

test("module view: a drop on another column asks for the module's move, and nothing when it has none or the card did not move", () => {
  assert.deepEqual(moveAction(card, "doing", "todo", card.actions), { action: "move", id: "c1", column: "doing" });
  assert.equal(moveAction(card, "todo", "todo", card.actions), null);
  assert.equal(moveAction(card, "other", "todo", card.actions), null, "the Other column is no place to move to");
  assert.equal(moveAction(card, "doing", "todo", [{ id: "nudge" }]), null);
});

test("module view: a card shows its actions but not the move (that is the drag), and a summary's bars are shares of the largest", () => {
  assert.deepEqual(actionsOf(card).map(a => a.id), ["nudge"]);
  assert.deepEqual(barHeights({ points: [{ label: "Mon", value: 3 }, { label: "Tue", value: 6 }, { label: "Wed", value: 0 }] }).map(b => b.share), [0.5, 1, 0]);
  assert.deepEqual(barHeights(undefined), []);
});

test("emailOf: a record's address as one string, from a text field or a list, and nothing otherwise", () => {
  assert.equal(emailOf({ email: " jo@example.com " }), "jo@example.com");
  assert.equal(emailOf({ email: ["", "jo@example.com", "x@y.z"] }), "jo@example.com");
  for (const bad of [null, undefined, {}, { email: 5 }, { email: [] }, { email: { a: 1 } }, "jo@example.com"]) assert.equal(emailOf(bad), "");
});

test("no app route has a segment named [screen]: React Navigation reserves `screen`, and a link to /u/module/<module>/<screen> lost it (the address became .../undefined)", async () => {
  const fs = await import("node:fs"), path = await import("node:path");
  const root = new URL("../../app/", import.meta.url).pathname;
  const bad = [];
  (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (/\[(screen|params)\]/.test(e.name)) bad.push(path.join(dir, e.name)); if (e.isDirectory()) walk(path.join(dir, e.name)); } })(root);
  assert.deepEqual(bad, []);
  assert.ok(fs.existsSync(path.join(root, "u", "module", "[module]", "[view].tsx")), "the module screen route takes the view as `view`");
});
