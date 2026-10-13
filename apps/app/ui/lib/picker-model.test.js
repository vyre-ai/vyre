import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { filterItems, moveActive, pickerKey, deleteTokenBack, scrollTopFor, composerShortcut, tokensIn, removeToken, jumpIndex, stepFocus, moveProject, toggleAnswering, answeringSummary } from "./picker-model.js";

const items = [{ id: 1, label: "Dana Wine" }, { id: 2, label: "Anna" }, { id: 3, label: "Claude" }, { id: 4, label: "Wine list" }];

test("filterItems ranks prefix before contains and drops misses", () => {
  assert.deepEqual(filterItems(items, "wine").map((i) => i.id), [4, 1]);
  assert.deepEqual(filterItems(items, "an").map((i) => i.id), [2, 1]);
  assert.equal(filterItems(items, "zzz").length, 0);
  assert.equal(filterItems(items, "").length, 4);
});

test("filterItems caps the list", () => {
  assert.equal(filterItems(Array.from({ length: 30 }, (_, i) => ({ id: i, label: "x" + i })), "", 8).length, 8);
});

test("moveActive wraps both ways and survives an empty list", () => {
  assert.equal(moveActive(0, -1, 4), 3);
  assert.equal(moveActive(3, 1, 4), 0);
  assert.equal(moveActive(1, 1, 4), 2);
  assert.equal(moveActive(0, 1, 0), 0);
});

test("pickerKey maps keys to actions", () => {
  assert.equal(pickerKey({ key: "ArrowDown" }, { query: "", count: 3 }), "next");
  assert.equal(pickerKey({ key: "ArrowUp" }, { query: "", count: 3 }), "prev");
  assert.equal(pickerKey({ key: "Enter" }, { query: "a", count: 3 }), "pick");
  assert.equal(pickerKey({ key: "Tab" }, { query: "a", count: 3 }), "pick");
  assert.equal(pickerKey({ key: "Escape" }, { query: "a", count: 3 }), "close");
  assert.equal(pickerKey({ key: "Backspace" }, { query: "", count: 3 }), "close");
  assert.equal(pickerKey({ key: "Backspace" }, { query: "a", count: 3 }), null);
  assert.equal(pickerKey({ key: "x" }, { query: "a", count: 3 }), null);
});

test("pickerKey with nothing to pick lets Enter and Tab through", () => {
  assert.equal(pickerKey({ key: "Enter" }, { query: "zz", count: 0 }), null);
  assert.equal(pickerKey({ key: "Tab" }, { query: "zz", count: 0 }), null);
  assert.equal(pickerKey({ key: "Enter", shiftKey: true }, { query: "a", count: 3 }), null);
  assert.equal(pickerKey({ key: "ArrowDown" }, { query: "", count: 0 }), null);
});

test("deleteTokenBack removes the whole token before the caret", () => {
  const names = ["Dana Wine", "Claude"];
  assert.deepEqual(deleteTokenBack("hi @Dana Wine ", 14, names), { text: "hi ", caret: 3 });
  assert.deepEqual(deleteTokenBack("hi @Claude", 10, names), { text: "hi ", caret: 3 });
  assert.deepEqual(deleteTokenBack("a #Claude b", 9, names), { text: "a  b", caret: 2 });
});

test("deleteTokenBack leaves ordinary text alone", () => {
  assert.equal(deleteTokenBack("hi @Dan", 7, ["Dana Wine"]), null);
  assert.equal(deleteTokenBack("hello", 5, ["Dana Wine"]), null);
  assert.equal(deleteTokenBack("@Claude", 3, ["Claude"]), null);
});

test("scrollTopFor brings the active row into view", () => {
  assert.equal(scrollTopFor(0, 36, 0, 144), 0);
  assert.equal(scrollTopFor(5, 36, 0, 144), 36 * 6 - 144);
  assert.equal(scrollTopFor(1, 36, 72, 144), 36);
  assert.equal(scrollTopFor(3, 36, 36, 144), 36);
});

test("composerShortcut reads the AI picker and attach keys", () => {
  assert.equal(composerShortcut({ key: "/", metaKey: true }), "answering");
  assert.equal(composerShortcut({ key: "/", ctrlKey: true }), "answering");
  assert.equal(composerShortcut({ key: "u", metaKey: true }), "attach");
  assert.equal(composerShortcut({ key: "1", altKey: true }), "ai:0");
  assert.equal(composerShortcut({ key: "3", altKey: true }), "ai:2");
  assert.equal(composerShortcut({ key: "0", altKey: true }), "ai:all");
  assert.equal(composerShortcut({ key: "/" }), null);
  assert.equal(composerShortcut({ key: "u" }), null);
});

test("toggleAnswering: empty means the default, picking all collapses to empty", () => {
  const all = ["a", "b", "c"];
  assert.deepEqual(toggleAnswering([], "b", all), ["b"]);
  assert.deepEqual(toggleAnswering(["b"], "c", all), ["b", "c"]);
  assert.deepEqual(toggleAnswering(["b", "c"], "b", all), ["c"]);
  assert.deepEqual(toggleAnswering(["c"], "c", all), []);
  assert.deepEqual(toggleAnswering(["a", "b"], "c", all), ["a", "b", "c"]);
});

test("answeringSummary says who answers", () => {
  const all = [{ id: "a", label: "Claude" }, { id: "b", label: "Codex" }, { id: "c", label: "Grok" }];
  assert.equal(answeringSummary([], all, "a"), "Claude");
  assert.equal(answeringSummary(["b"], all, "a"), "Codex");
  assert.equal(answeringSummary(["a", "b"], all, "a"), "Claude and Codex");
  assert.equal(answeringSummary(["a", "b", "c"], all, "a"), "Everyone");
});

test("composerShortcut reads the physical digit when Option types a symbol", () => {
  assert.equal(composerShortcut({ key: "\u00a1", code: "Digit1", altKey: true }), "ai:0");
  assert.equal(composerShortcut({ key: "\u2122", code: "Digit2", altKey: true }), "ai:1");
});

test("tokensIn lists the tokens still in the words, in order", () => {
  assert.deepEqual(tokensIn("ask @Claude about #Q3 plan now", ["Claude", "Q3 plan", "Anna"]), [{ lead: "@", name: "Claude" }, { lead: "#", name: "Q3 plan" }]);
  assert.deepEqual(tokensIn("mail@Claude.com", ["Claude"]), []);
  assert.deepEqual(tokensIn("@Claudette hi", ["Claude"]), []);
});

test("removeToken takes one token and its space out", () => {
  assert.equal(removeToken("ask @Claude now", "@", "Claude"), "ask now");
  assert.equal(removeToken("@Claude", "@", "Claude"), "");
  assert.equal(removeToken("hi", "@", "Claude"), "hi");
});

test("a name with a space is written in quotes and the token model follows it", () => {
  assert.deepEqual(deleteTokenBack('hi #"Q3 intake" ', 16, ["Q3 intake"]), { text: "hi ", caret: 3 });
  assert.deepEqual(tokensIn('see #"Q3 intake" now', ["Q3 intake"]), [{ lead: "#", name: "Q3 intake" }]);
  assert.equal(removeToken('see #"Q3 intake" now', "#", "Q3 intake"), "see now");
});

test("jumpIndex finds the next row that starts with what was typed", () => {
  const labels = ["Fork this chat", "Effort", "Files", "Mode", "Mute"];
  assert.equal(jumpIndex(labels, 0, "f"), 2);
  assert.equal(jumpIndex(labels, 2, "f"), 0);
  assert.equal(jumpIndex(labels, 0, "mu"), 4);
  assert.equal(jumpIndex(labels, 3, "m"), 4);
  assert.equal(jumpIndex(labels, 0, "zz"), -1);
});

test("stepFocus moves one row and wraps; Home and End go to the ends", () => {
  assert.equal(stepFocus(0, 5, "ArrowUp"), 4);
  assert.equal(stepFocus(4, 5, "ArrowDown"), 0);
  assert.equal(stepFocus(2, 5, "Home"), 0);
  assert.equal(stepFocus(2, 5, "End"), 4);
  assert.equal(stepFocus(2, 5, "x"), -1);
  assert.equal(stepFocus(0, 0, "ArrowDown"), -1);
});

test("moveProject says what to add and remove to move a thread", () => {
  assert.deepEqual(moveProject(["a"], "b"), { add: "b", remove: ["a"] });
  assert.deepEqual(moveProject(["a", "b"], "b"), { add: null, remove: ["a"] });
  assert.deepEqual(moveProject([], "b"), { add: "b", remove: [] });
  assert.deepEqual(moveProject(["a"], null), { add: null, remove: ["a"] });
});
