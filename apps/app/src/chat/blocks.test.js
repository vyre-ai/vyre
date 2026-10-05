// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBlock, parseUnified, countDiff, sideBySide, fileTree, sealedCount } from "./blocks.js";
import { parseAnsi, stripAnsi } from "./ansi.js";

test("every kind maps to its component block", () => {
  const cases = [
    [{ block: "terminal", command: "ls", output: "a", exit: 0 }, "terminal"],
    [{ block: "diff", files: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] }, "diff"],
    [{ block: "files", files: [{ path: "a.ts", add: 1, del: 0 }] }, "diff"],
    [{ block: "record", title: "Matter", fields: [] }, "record"],
    [{ block: "task", title: "Send it", state: "needs-approval" }, "task"],
    [{ block: "draft", body: "Hello" }, "draft"],
    [{ block: "flow-change", steps: [{ op: "add", label: "x" }] }, "flow-change"],
    [{ block: "answer", text: "yes", sources: [{ title: "n" }] }, "answer"],
    [{ block: "screen", frames: ["data:image/png;base64,AA"] }, "screen"],
    [{ block: "text", text: "hi" }, "text"],
  ];
  for (const [raw, kind] of cases) assert.equal(normalizeBlock(raw).block, kind, JSON.stringify(raw));
});

test("unknown or malformed results become short text, never JSON", () => {
  assert.deepEqual(normalizeBlock({ block: "hologram", x: 1 }, "Done"), { block: "text", text: "Done" });
  assert.deepEqual(normalizeBlock(null, "Ran it"), { block: "text", text: "Ran it" });
  assert.deepEqual(normalizeBlock({ summary: "Moved 3 files" }), { block: "text", text: "Moved 3 files" });
  assert.deepEqual(normalizeBlock({ block: "record" }, "Found"), { block: "text", text: "Found" });
  const t = normalizeBlock({ weird: { deep: [1, 2, 3] } }, "Done");
  assert.equal(t.block, "text");
  assert.ok(!/[{}\[\]]/.test(/** @type {any} */ (t).text));
});

test("a sealed field never carries a value, a ref or a hint", () => {
  const b = /** @type {any} */ (normalizeBlock({
    block: "record", title: "Matter",
    fields: [
      { label: "SSN", kind: "sealed", value: { sealed: "ssn", ref: "vault:ssn:9", present: true, valid_format: true, hint: "last4:6789" } },
      { label: "Leaked", kind: "text", sealed: true, value: "123-45-6789" },
      { label: "Stage", kind: "stage", value: "Open" },
    ],
  }));
  const s = JSON.stringify(b);
  for (const secret of ["vault:ssn:9", "6789", "123-45"]) assert.ok(!s.includes(secret), secret);
  assert.equal(b.fields[0].sealed, true);
  assert.equal(b.fields[0].cls, "ssn");
  assert.equal(b.fields[1].sealed, true);
  assert.equal(b.fields[2].value, "Open");
  assert.equal(sealedCount(b), 2);
});

test("unified diffs parse, count and pair side by side", () => {
  const diff = "@@ -1,3 +1,3 @@\n a\n-b\n-c\n+B\n d";
  const lines = parseUnified(diff);
  assert.deepEqual(lines.map((l) => l.t), ["hunk", "ctx", "del", "del", "add", "ctx"]);
  assert.deepEqual(countDiff(diff), { add: 1, del: 2 });
  const pairs = sideBySide(lines);
  assert.equal(pairs[2].left?.text, "b");
  assert.equal(pairs[2].right?.text, "B");
  assert.equal(pairs[3].right, null);
});

test("many files fold into a tree by folder", () => {
  const tree = fileTree([
    { path: "src/a.ts", op: "edit", diff: "", add: 1, del: 0 },
    { path: "src/b.ts", op: "edit", diff: "", add: 2, del: 1 },
    { path: "README.md", op: "edit", diff: "", add: 1, del: 1 },
  ]);
  assert.deepEqual(tree.map((t) => t.dir), [".", "src"]);
  assert.equal(tree[1].files.length, 2);
});

test("ansi colours become spans, other escapes are dropped", () => {
  const spans = parseAnsi("\x1b[32mok\x1b[0m plain \x1b[1;31mfail\x1b[0m\x1b[2K");
  assert.deepEqual(spans.map((s) => [s.text, s.fg, s.bold]), [["ok", "green", false], [" plain ", null, false], ["fail", "red", true]]);
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
});

test("a cited field: a field-ref is never a value; a field is a value, a sealed chip or a hidden chip", () => {
  const ref = /** @type {any} */ (normalizeBlock({ block: "field-ref", record: "vyre://s/matter/1", field: "fee", label: "Fee", value: "4200" }));
  assert.deepEqual([ref.block, ref.label, ref.state, ref.value], ["field", "Fee", "hidden", ""]);
  const val = /** @type {any} */ (normalizeBlock({ block: "field", label: "Fee", kind: "money", value: { amount: 4200, currency: "USD" } }));
  assert.deepEqual([val.state, val.value], ["value", "USD 4200"]);
  const hid = /** @type {any} */ (normalizeBlock({ block: "field", label: "Fee", kind: "money", placeholder: true, value: { hidden: "role", kind: "money", present: true } }));
  assert.deepEqual([hid.state, hid.value, hid.present], ["hidden", "", true]);
  const sealed = /** @type {any} */ (normalizeBlock({ block: "field", label: "SSN", kind: "sealed", sealed: true, placeholder: true, value: { sealed: "ssn", present: true, ref: "r_SECRET" } }));
  assert.deepEqual([sealed.state, sealed.cls, sealed.value], ["sealed", "ssn", ""]);
  assert.ok(!JSON.stringify(sealed).includes("r_SECRET"));
});

test("the room note: a terminal or diff block keeps the server's line, a block without one has none, and the app never makes one", () => {
  const NOTE = "visible to everyone in this chat";
  const term = /** @type {any} */ (normalizeBlock({ block: "terminal", command: "ls", output: "a", exit: 0, note: NOTE }));
  assert.equal(term.note, NOTE);
  const diff = /** @type {any} */ (normalizeBlock({ block: "files", files: [{ path: "a.md", op: "edit", diff: "+x" }], note: NOTE }));
  assert.deepEqual([diff.block, diff.note], ["diff", NOTE]);
  assert.ok(!("note" in /** @type {any} */ (normalizeBlock({ block: "terminal", command: "ls", output: "a", exit: 0 }))), "a one-person chat's block has no note");
  assert.ok(!("note" in /** @type {any} */ (normalizeBlock({ block: "terminal", command: "ls", output: "a", note: 5 }))), "only a string is a note");
  assert.equal(/** @type {any} */ (normalizeBlock({ block: "terminal", command: "x", output: "", note: "y".repeat(500) })).note.length, 120);
});

test("a watcher, a spend cap and a welcome come through as their own blocks; a watcher with no name is plain text", () => {
  assert.deepEqual(normalizeBlock({ block: "watcher", name: "new-lead" }), { block: "watcher", name: "new-lead" });
  assert.deepEqual(normalizeBlock({ block: "spend-cap", provider: "openai", cap: 5, line: "Paused at $5" }), { block: "spend-cap", provider: "openai", cap: 5, line: "Paused at $5" });
  assert.deepEqual(normalizeBlock({ block: "welcome" }), { block: "welcome" });
  assert.equal(normalizeBlock({ block: "watcher" }).block, "text");
});
