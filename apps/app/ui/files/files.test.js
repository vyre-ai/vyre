// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewerKind, languageOf, canEdit, isTextKind, mimeFor } from "./kinds.js";
import { lineDiff, diffStats, hunks, linesOf } from "./diff.js";
import { looksBinary, textOfBytes, bytesOfText, base64Of, editState, needsGuard, saveWords, tagParts, taskOf, toggleTask, outline, fileCardOf, changedBy } from "./viewer-model.js";

test("every file type picks one renderer, by name first and then by the type the server gave", () => {
  const cases = { "README.md": "markdown", "a.MD": "markdown", "x.json": "json", "main.rs": "code", "Dockerfile": "code", "notes.txt": "text", "p.PNG": "image", "d.pdf": "pdf", "w.docx": "docx", "s.xlsx": "sheet", "t.csv": "sheet", "a.mp3": "audio", "v.mov": "video", "i.html": "html", "x.zip": "other", "noext": "other", "a.ts": "code", "c.yaml": "code" };
  for (const [n, k] of Object.entries(cases)) assert.equal(viewerKind(n), k, n);
  assert.equal(viewerKind("blob", "application/pdf"), "pdf");
  assert.equal(viewerKind("blob", "text/csv"), "sheet");
  assert.equal(viewerKind("blob", "image/png"), "image");
  assert.equal(viewerKind("blob", "text/plain"), "text");
  assert.equal(viewerKind("blob", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assert.equal(viewerKind("blob", "application/octet-stream"), "other");
  assert.equal(languageOf("a/b/main.jsx"), "js");
  assert.ok(canEdit("markdown") && canEdit("code") && !canEdit("json") && !canEdit("pdf") && isTextKind("json"));
  assert.equal(mimeFor("a.jpg", "image"), "image/jpeg");
  assert.equal(mimeFor("a.svg", "image"), "image/svg+xml");
});

test("a line diff keeps the common start and end, and reports what was added and removed", () => {
  const ops = lineDiff("a\nb\nc\nd\n", "a\nb2\nc\nd\ne\n");
  assert.deepEqual(ops.map(o => o.t + ":" + o.line), ["eq:a", "del:b", "add:b2", "eq:c", "eq:d", "add:e"]);
  assert.deepEqual(diffStats(ops), { add: 2, del: 1 });
  assert.deepEqual(lineDiff("", "x\ny"), [{ t: "add", line: "x" }, { t: "add", line: "y" }]);
  assert.deepEqual(lineDiff("same", "same"), [{ t: "eq", line: "same" }]);
  assert.deepEqual(linesOf("a\r\nb\n"), ["a", "b"]);
  assert.deepEqual(diffStats(lineDiff("x\ny", "")), { add: 0, del: 2 });
});

test("a diff of a huge change does not run away, and hunks fold the unchanged middle", () => {
  const big = Array.from({ length: 3000 }, (_, i) => "a" + i).join("\n"), other = Array.from({ length: 3000 }, (_, i) => "b" + i).join("\n");
  const ops = lineDiff(big, other);
  assert.deepEqual(diffStats(ops), { add: 3000, del: 3000 });
  const lines = Array.from({ length: 40 }, (_, i) => "l" + i);
  const after = lines.slice(); after[2] = "X"; after[37] = "Y";
  const h = hunks(lineDiff(lines.join("\n"), after.join("\n")), 2);
  assert.ok(h.some(x => x.t === "gap"), "a long unchanged stretch folds");
  assert.ok(h.filter(x => x.t === "add").length === 2);
});

test("bytes read as text without TextDecoder and write back exactly, and binary is told from text", () => {
  const s = "héllo € \u{1F600} line\n";
  assert.equal(textOfBytes(bytesOfText(s)), s);
  assert.equal(textOfBytes([0xef, 0xbb, 0xbf, 0x41]), "A", "a byte order mark is dropped");
  assert.equal(textOfBytes([0xff, 0x41]), "�A");
  assert.equal(looksBinary(bytesOfText("plain text\n")), false);
  assert.equal(looksBinary([0x50, 0x4b, 0, 3, 4]), true);
  assert.equal(base64Of(bytesOfText("hi")), "aGk=");
  assert.equal(base64Of(bytesOfText("hello")), "aGVsbG8=");
  assert.equal(base64Of([]), "");
});

test("the edit state is dirty only when the draft differs, a guard stops leaving with unsaved changes, and a conflict is said plainly", () => {
  assert.deepEqual(editState("a", "a"), { dirty: false, canSave: false });
  assert.deepEqual(editState("a", "ab"), { dirty: true, canSave: true });
  assert.equal(needsGuard(editState("a", "b")), true);
  assert.equal(needsGuard(editState("a", "a")), false);
  assert.match(saveWords({ conflict: true }), /both are kept/);
  assert.equal(saveWords({}), "Saved.");
});

test("@ and # tags are found as chips, not inside words or emails", () => {
  assert.deepEqual(tagParts("ask @kit about #Q3-plan now"), [{ t: "text", v: "ask " }, { t: "tag", v: "@kit", kind: "mention" }, { t: "text", v: " about " }, { t: "tag", v: "#Q3-plan", kind: "record" }, { t: "text", v: " now" }]);
  assert.deepEqual(tagParts("mail me at a@b.com"), [{ t: "text", v: "mail me at a@b.com" }]);
  assert.deepEqual(tagParts("(@kit)"), [{ t: "text", v: "(" }, { t: "tag", v: "@kit", kind: "mention" }, { t: "text", v: ")" }]);
  assert.deepEqual(tagParts("plain"), [{ t: "text", v: "plain" }]);
});

test("checklist items are read and toggled in the source, in document order", () => {
  assert.deepEqual(taskOf("[ ] buy milk"), { checked: false, text: "buy milk" });
  assert.deepEqual(taskOf("[X] done"), { checked: true, text: "done" });
  assert.equal(taskOf("[link](x)"), null);
  const src = "- [ ] one\n- [x] two\n  - [ ] three\n```\n- [ ] not in a fence is still counted by the renderer\n```\n";
  assert.equal(toggleTask(src, 0).split("\n")[0], "- [x] one");
  assert.equal(toggleTask(src, 1).split("\n")[1], "- [ ] two");
  assert.equal(toggleTask(src, 2).split("\n")[2], "  - [x] three");
});

test("the outline lists headings outside code fences", () => {
  assert.deepEqual(outline("# A\ntext\n```\n# not\n```\n## B ##\n"), [{ level: 1, title: "A", line: 1 }, { level: 2, title: "B", line: 6 }]);
});

test("a file a model made or changed becomes a card, and a delete does not open", () => {
  const c = fileCardOf({ path: "notes/plan.md", op: "create", add: 40, del: 0 });
  assert.deepEqual([c.name, c.kind, c.action, c.openable, c.line], ["plan.md", "markdown", "created", true, "created, +40"]);
  assert.equal(fileCardOf({ path: "a.ts", op: "edit", add: 3, del: 1 }).line, "edited, +3 −1");
  assert.equal(fileCardOf({ path: "a.ts", op: "delete" }).openable, false);
  assert.equal(changedBy({ by: "agent:kit" }, id => id.toUpperCase()), "Changed by KIT");
  assert.equal(changedBy({ by: "person:per_x" }), "Changed by per_x");
  assert.equal(changedBy({}), "");
});
