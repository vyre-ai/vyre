// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { messageMenu, barItems, askedBefore, threadMay } from "./message-menu-model.js";

const all = { reply: true, forward: true, fork: true, ask: true, second: true, edit: true, retry: true, rewind: true, pin: true };
const ids = (/** @type {import("./message-menu-model.js").MessageMenu} */ m) => m.groups.map((g) => g.map((i) => i.id));

test("an agent's reply: reply, forward and copy; fork, ask and second opinion; retry, rewind and pin; no edit", () => {
  const m = messageMenu({ mine: false, done: true, reactions: ["a", "b", "c"], can: all, codeBlocks: 2 });
  assert.deepEqual(ids(m), [["reply", "forward", "copy"], ["fork", "ask", "second"], ["retry", "rewind", "pin"]]);
  assert.deepEqual(m.reactions, ["a", "b", "c"]);
  assert.deepEqual(m.groups[0][2].children?.map((c) => c.label), ["Copy text", "Copy as Markdown", "Copy code 1", "Copy code 2"]);
  assert.equal(m.groups[1][0].label, "Fork from here");
});

test("your own message: fork says before it, no second opinion, edit appears and retry does not (it sits on the answer)", () => {
  const m = messageMenu({ mine: true, done: true, can: all, codeBlocks: 1 });
  assert.deepEqual(ids(m), [["reply", "forward", "copy"], ["fork", "ask"], ["edit", "rewind", "pin"]]);
  assert.equal(m.groups[1][0].label, "Fork before this message");
  assert.deepEqual(m.groups[0][2].children?.map((c) => c.label), ["Copy text", "Copy as Markdown", "Copy code"]);
});

test("what a message cannot do is left out, and an empty group goes with it; no reactions without a way to react", () => {
  const m = messageMenu({ mine: false, done: false, can: { reply: true }, pinned: false });
  assert.deepEqual(ids(m), [["reply"]], "a message still being written cannot be copied");
  assert.deepEqual(m.reactions, []);
  assert.deepEqual(ids(messageMenu({ can: {} })), []);
  assert.equal(messageMenu({ can: { pin: true }, pinned: true, mine: false }).groups[0][0].label, "Unpin");
  // a driver that cannot go back or fork: no retry, edit, rewind or fork
  assert.deepEqual(ids(messageMenu({ mine: false, done: true, can: { reply: true, ask: true, pin: true } })), [["reply", "copy"], ["ask"], ["pin"]]);
});

test("the hover bar is Copy, Reply and the three dots", () => {
  assert.deepEqual(barItems({ copy: true, reply: true }), ["copy", "reply", "more"]);
  assert.deepEqual(barItems({ copy: false, reply: false }), ["more"]);
});

test("askedBefore: the person's own message an answer or a failed reply follows; another person's message, or none, is null", () => {
  /** @type {Record<string, { kind: string, text?: string, command?: boolean }>} */ const items = {
    "u:a": { kind: "user", text: "first" }, "m:x": { kind: "text", text: "answer one" }, "u:b": { kind: "user", text: "second" }, "m:y": { kind: "text", text: "part" }, "m:z": { kind: "text", text: "more" },
    "s:9": { kind: "notice", text: "Couldn't answer." }, "u:c": { kind: "user", text: "carol says" }, "m:w": { kind: "text", text: "to carol" },
  };
  const rows = ["u:a", "m:x", "u:b", "m:y", "m:z", "s:9", "u:c", "m:w"].map((key) => ({ key }));
  const item = (/** @type {string} */ k) => items[k];
  const mine = (/** @type {string} */ k) => k !== "u:c";
  assert.deepEqual(askedBefore(rows, "m:x", item, mine), { uuid: "a", text: "first" });
  assert.deepEqual(askedBefore(rows, "m:z", item, mine), { uuid: "b", text: "second" }, "an answer in two parts still finds the message");
  assert.deepEqual(askedBefore(rows, "s:9", item, mine), { uuid: "b", text: "second" }, "a failed reply's Try again");
  assert.equal(askedBefore(rows, "m:w", item, mine), null, "another person's message is not yours to retry");
  assert.equal(askedBefore(rows, "u:a", item, mine), null);
  assert.equal(askedBefore(rows, "nope", item, mine), null);
});

test("threadMay: Claude and an unknown thread offer everything; another driver only what its caps say, as the server reads them", () => {
  assert.deepEqual(threadMay(null), { rewind: true, fork: true, branch: true });
  assert.deepEqual(threadMay({ provider: "claude", caps: { rewind: true } }), { rewind: true, fork: true, branch: true });
  assert.deepEqual(threadMay({ provider: "openrouter", caps: { streaming: true } }), { rewind: false, fork: false, branch: false });
  assert.deepEqual(threadMay({ provider: "codex", caps: { fork: true, rewind: { conversation: false, code: false } } }), { rewind: false, fork: true, branch: false });
  assert.deepEqual(threadMay({ provider: "grok", caps: null }), { rewind: false, fork: false, branch: false });
  assert.deepEqual(threadMay({ provider: "x", caps: { fork: true, rewind: { conversation: true } } }), { rewind: true, fork: true, branch: true });
  assert.deepEqual(threadMay({ provider: "x", caps: { rewind: true } }), { rewind: false, fork: false, branch: false }, "a bare true is not a declared rewind");
});
