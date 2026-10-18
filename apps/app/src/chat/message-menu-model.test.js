// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { messageMenu, barItems } from "./message-menu-model.js";

const all = { reply: true, forward: true, fork: true, ask: true, second: true, edit: true, retry: true, rewind: true, pin: true };
const ids = (/** @type {import("./message-menu-model.js").MessageMenu} */ m) => m.groups.map((g) => g.map((i) => i.id));

test("an agent's reply: reply, forward and copy; fork, ask and second opinion; rewind and pin; no edit or retry", () => {
  const m = messageMenu({ mine: false, done: true, reactions: ["a", "b", "c"], can: all, codeBlocks: 2 });
  assert.deepEqual(ids(m), [["reply", "forward", "copy"], ["fork", "ask", "second"], ["rewind", "pin"]]);
  assert.deepEqual(m.reactions, ["a", "b", "c"]);
  assert.deepEqual(m.groups[0][2].children?.map((c) => c.label), ["Copy as Markdown", "Copy code 1", "Copy code 2"]);
  assert.equal(m.groups[1][0].label, "Fork from here");
});

test("your own message: fork says before it, no second opinion, edit and retry appear", () => {
  const m = messageMenu({ mine: true, done: true, can: all, codeBlocks: 1 });
  assert.deepEqual(ids(m), [["reply", "forward", "copy"], ["fork", "ask"], ["edit", "retry", "rewind", "pin"]]);
  assert.equal(m.groups[1][0].label, "Fork before this message");
  assert.deepEqual(m.groups[0][2].children?.map((c) => c.label), ["Copy as Markdown", "Copy code"]);
});

test("what a message cannot do is left out, and an empty group goes with it; no reactions without a way to react", () => {
  const m = messageMenu({ mine: false, done: false, can: { reply: true }, pinned: false });
  assert.deepEqual(ids(m), [["reply"]], "a message still being written cannot be copied");
  assert.deepEqual(m.reactions, []);
  assert.deepEqual(ids(messageMenu({ can: {} })), []);
  assert.equal(messageMenu({ can: { pin: true }, pinned: true, mine: false }).groups[0][0].label, "Unpin");
});

test("the hover bar is Copy, Reply and the three dots", () => {
  assert.deepEqual(barItems({ copy: true, reply: true }), ["copy", "reply", "more"]);
  assert.deepEqual(barItems({ copy: false, reply: false }), ["more"]);
});
