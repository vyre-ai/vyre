import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToPlain, codeBlocks, copyForms, findMatches, stepMatch, findLabel, keyAction, lastOwnMessage, looksTechnical, headerParts } from "./polish.js";

test("copy: plain drops the markdown, markdown keeps it, and each fenced block is found whole", () => {
  const md = "## Plan\n\nDo **this** first, see [the doc](https://x.example).\n\n```js\nconst a = 1;\n```\n\n- one\n- two";
  assert.equal(copyForms(md).markdown, md);
  const plain = copyForms(md).plain;
  assert.ok(!plain.includes("**") && !plain.includes("##") && !plain.includes("```"), plain);
  assert.match(plain, /Do this first, see the doc \(https:\/\/x\.example\)\./);
  assert.match(plain, /const a = 1;/);
  assert.match(plain, /- one\n- two/);
  assert.deepEqual(codeBlocks(md), [{ lang: "js", code: "const a = 1;" }]);
  assert.deepEqual(codeBlocks("no code here"), []);
  assert.equal(mdToPlain("`x` and *y*"), "x and y");
});

test("find: matches rows case-insensitively with counts, steps with wrap, and labels itself", () => {
  const items = [{ key: "u:1", text: "Chase the invoices" }, { key: "a:1", text: "Three INVOICES are late; invoices for Northwind." }, { key: "a:2", text: "Nothing here" }];
  const m = findMatches(items, "invoices");
  assert.deepEqual(m, [{ key: "u:1", count: 1 }, { key: "a:1", count: 2 }]);
  assert.deepEqual(findMatches(items, "  "), []);
  assert.equal(stepMatch(-1, 1, 2), 0);
  assert.equal(stepMatch(-1, -1, 2), 1);
  assert.equal(stepMatch(1, 1, 2), 0, "wraps forward");
  assert.equal(stepMatch(0, -1, 2), 1, "wraps back");
  assert.equal(stepMatch(0, 1, 0), -1);
  assert.equal(findLabel(0, 2, "invoices"), "1 of 2");
  assert.equal(findLabel(0, 0, "zzz"), "No matches");
  assert.equal(findLabel(0, 0, ""), "");
});

test("keys: each key in the set maps to one action, and Up edits only from an empty composer", () => {
  const c = { composerEmpty: true, busy: false, findOpen: false, canEdit: true };
  assert.deepEqual(keyAction({ key: "f", meta: true }, c), { do: "find" });
  assert.deepEqual(keyAction({ key: "k", meta: true }, c), { do: "switch" });
  assert.deepEqual(keyAction({ key: "Enter", meta: true }, c), { do: "steer" });
  assert.deepEqual(keyAction({ key: "3", meta: true }, c), { do: "jump", n: 3 });
  assert.equal(keyAction({ key: "0", meta: true }, c), null);
  assert.deepEqual(keyAction({ key: "ArrowUp" }, c), { do: "edit-last" });
  assert.equal(keyAction({ key: "ArrowUp" }, { ...c, composerEmpty: false }), null, "words in the composer: Up moves the caret");
  assert.equal(keyAction({ key: "ArrowUp" }, { ...c, canEdit: false }), null);
  assert.equal(keyAction({ key: "Escape" }, c), null, "nothing to stop");
  assert.deepEqual(keyAction({ key: "Escape" }, { ...c, busy: true }), { do: "stop" });
  assert.deepEqual(keyAction({ key: "Escape" }, { ...c, busy: true, findOpen: true }), { do: "close-find" }, "Esc closes find before it stops a reply");
  assert.equal(keyAction({ key: "a" }, c), null);
});

test("edit last: the newest message the person sent, never an optimistic or queued one", () => {
  const rows = [{ key: "u:1", kind: "user" }, { key: "a:1", kind: "text" }, { key: "u:2", kind: "user" }, { key: "o:1", kind: "user" }];
  const items = { "u:1": { text: "first" }, "u:2": { text: "second" }, "o:1": { text: "sending", pending: true } };
  const mine = () => true;
  assert.deepEqual(lastOwnMessage(rows, (k) => items[k], mine), { uuid: "2", text: "second" });
  assert.equal(lastOwnMessage([], () => null, mine), null);
  assert.deepEqual(lastOwnMessage(rows, (k) => items[k], (k) => k === "u:1"), { uuid: "1", text: "first" });
});

test("header: the project and which AI answers, never an id or a path", () => {
  assert.equal(looksTechnical("ses_ab12cd34ef"), true);
  assert.equal(looksTechnical("/srv/vyre/work/x"), true);
  assert.equal(looksTechnical("~/code"), true);
  assert.equal(looksTechnical("C:\\Users\\x"), true);
  assert.equal(looksTechnical("0123456789abcdef"), true);
  assert.equal(looksTechnical("Northwind Bakery"), false);
  assert.deepEqual(headerParts({ title: "ses_ab12cd34ef", project: "Northwind Bakery", answeredBy: ["Claude"] }), { title: "Northwind Bakery", line: "Claude answers" });
  assert.deepEqual(headerParts({ title: "Lease dispute", project: "Northwind Bakery", space: "Juniper Studio", answeredBy: ["Claude", "Codex", "Grok"] }), { title: "Lease dispute", line: "Northwind Bakery · Juniper Studio · Claude and Codex answer" });
  assert.deepEqual(headerParts({ title: "/Users/x/proj", where: "/srv/box" }), { title: "Chat", line: "" });
  assert.deepEqual(headerParts({}), { title: "Chat", line: "" });
});
