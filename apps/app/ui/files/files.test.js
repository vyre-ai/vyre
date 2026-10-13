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

import { applyFormat, continueList } from "./edit-ops.js";

test("formatting wraps and unwraps a selection and keeps the selection on the words", () => {
  assert.deepEqual(applyFormat("hello world", { start: 6, end: 11 }, "bold"), { text: "hello **world**", sel: { start: 8, end: 13 } });
  assert.deepEqual(applyFormat("hello **world**", { start: 8, end: 13 }, "bold"), { text: "hello world", sel: { start: 6, end: 11 } });
  assert.deepEqual(applyFormat("", { start: 0, end: 0 }, "code"), { text: "`text`", sel: { start: 1, end: 5 } });
  assert.equal(applyFormat("see this", { start: 4, end: 8 }, "link").text, "see [this](https://)");
});

test("block formats apply to every line touched, and a second press takes them off", () => {
  const two = "one\ntwo";
  assert.equal(applyFormat(two, { start: 0, end: 7 }, "bullet").text, "- one\n- two");
  assert.equal(applyFormat("- one\n- two", { start: 0, end: 11 }, "bullet").text, "one\ntwo");
  assert.equal(applyFormat(two, { start: 0, end: 7 }, "number").text, "1. one\n2. two");
  assert.equal(applyFormat("buy milk", { start: 0, end: 0 }, "task").text, "- [ ] buy milk");
  assert.equal(applyFormat("- [ ] buy milk", { start: 0, end: 0 }, "task").text, "buy milk");
  assert.equal(applyFormat("Title", { start: 0, end: 0 }, "h2").text, "## Title");
  assert.equal(applyFormat("## Title", { start: 0, end: 0 }, "h2").text, "Title");
  assert.equal(applyFormat("## Title", { start: 0, end: 0 }, "h1").text, "# Title");
  assert.equal(applyFormat("wise", { start: 0, end: 4 }, "quote").text, "> wise");
  assert.equal(applyFormat("x = 1", { start: 0, end: 5 }, "fence").text, "```\nx = 1\n```\n");
});

test("Enter continues a list, ends it on an empty item, and leaves other lines alone", () => {
  assert.deepEqual(continueList("- a", 3), { text: "- a\n- ", at: 6 });
  assert.deepEqual(continueList("- [x] done", 10), { text: "- [x] done\n- [ ] ", at: 17 });
  assert.deepEqual(continueList("1. a", 4), { text: "1. a\n2. ", at: 8 });
  assert.deepEqual(continueList("x\n- ", 4), { text: "x\n", at: 2 });
  assert.equal(continueList("plain", 5), null);
  assert.deepEqual(continueList("  - a", 5), { text: "  - a\n  - ", at: 10 });
});

import { neutralise, cleanCss } from "./neutralise.js";

/** A tiny DOM with just what neutralise touches, so the test needs no browser. */
function fake(tree) {
  const all = [];
  const mk = (tag, attrs = {}, text = "") => { const el = { tagName: tag.toUpperCase(), attrs: Object.entries(attrs).map(([name, value]) => ({ name, value })), textContent: text, gone: false,
    get attributes() { return this.attrs; }, removeAttribute(n) { this.attrs = this.attrs.filter(a => a.name !== n); }, setAttribute(n, v) { const a = this.attrs.find(x => x.name === n); if (a) a.value = v; else this.attrs.push({ name: n, value: v }); },
    getAttribute(n) { return this.attrs.find(a => a.name === n)?.value ?? null; }, remove() { this.gone = true; } }; all.push(el); return el; };
  const els = tree(mk);
  return { els, all, querySelectorAll(sel) { const tags = sel === "*" ? null : sel.split(",").map(s => s.toUpperCase()); return all.filter(e => !e.gone && (!tags || tags.includes(e.tagName))); } };
}

test("a hostile document is made inert: javascript and data links go, scripts and handlers go, an inline image stays", () => {
  const d = fake(mk => ({
    js: mk("a", { href: "javascript:alert(1)" }), js2: mk("a", { href: " JaVa\tScRiPt:alert(1)" }), data: mk("a", { href: "data:text/html;base64,PHNjcmlwdD4=" }), vb: mk("a", { href: "vbscript:x" }),
    ok: mk("a", { href: "https://example.com/x" }), mail: mk("a", { href: "mailto:a@b.co" }), rel: mk("a", { href: "/relative" }),
    img: mk("img", { src: "data:image/png;base64,iVBORw0KGgo=", onerror: "alert(1)" }), badimg: mk("img", { src: "https://track.example/p.gif" }), svg: mk("img", { src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }),
    script: mk("script", {}, "alert(1)"), frame: mk("iframe", { src: "https://x" }), form: mk("form", { action: "https://x" }), obj: mk("object", { data: "x" }), base: mk("base", { href: "https://evil" }),
    div: mk("div", { onclick: "alert(1)", onmouseover: "x", id: "k" }), style: mk("style", {}, "@import url(https://evil/x.css); p{background:url(https://evil/t.png)} q{background:url(data:image/png;base64,AAAA)}"),
  }));
  neutralise(d);
  const e = d.els;
  for (const k of ["js", "js2", "data", "vb", "rel"]) assert.equal(e[k].getAttribute("href"), null, k);
  assert.equal(e.ok.getAttribute("href"), "https://example.com/x"); assert.equal(e.mail.getAttribute("href"), "mailto:a@b.co");
  assert.equal(e.ok.getAttribute("rel"), "noopener noreferrer"); assert.equal(e.ok.getAttribute("target"), "_blank");
  assert.equal(e.js.getAttribute("target"), null, "a link with no target is not made openable");
  assert.equal(e.img.getAttribute("src"), "data:image/png;base64,iVBORw0KGgo="); assert.equal(e.img.getAttribute("onerror"), null);
  assert.equal(e.badimg.getAttribute("src"), null, "a remote image is a tracker");
  assert.equal(e.svg.getAttribute("src"), null, "an svg is not an inline image here");
  for (const k of ["script", "frame", "form", "obj", "base"]) assert.equal(e[k].gone, true, k);
  assert.equal(e.div.getAttribute("onclick"), null); assert.equal(e.div.getAttribute("onmouseover"), null); assert.equal(e.div.getAttribute("id"), "k");
  assert.ok(!/@import/.test(e.style.textContent) && !/evil/.test(e.style.textContent) && /data:image\/png/.test(e.style.textContent));
  assert.equal(cleanCss("a{b:url('https://x/y.png')}"), "a{b:none}");
});
