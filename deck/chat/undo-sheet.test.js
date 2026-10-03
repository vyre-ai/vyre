// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
const { historyOf, takesOff, undoneLine, undoSheet } = await import("./undo-sheet.js");

const H = { commits: [{ sha: "c3", subject: "add menu" }, { sha: "c2", subject: "fix tax" }, { sha: "c1", subject: "start" }], dirty: 2 };
const ev = n => new /** @type {any} */ (globalThis).Event(n);
const settle = () => new Promise(r => setTimeout(r, 5));

test("history is cleaned, and going back past a commit takes off it and the newer ones", () => {
  const h = historyOf({ commits: [{ sha: "a", subject: "" }, { subject: "no sha" }, null], dirty: "x" });
  assert.deepEqual(h, { commits: [{ sha: "a", subject: "(no message)" }], dirty: 0 });
  assert.equal(takesOff(H.commits, "c3"), 1);
  assert.equal(takesOff(H.commits, "c1"), 3);
  assert.equal(takesOff(H.commits, null), 3);
  assert.equal(takesOff(H.commits, "zz"), 0);
  assert.equal(undoneLine({ undone: 2, kept_unsaved: true }), "Took off 2 changes, and kept your unsaved work with it.");
  assert.equal(undoneLine({ undone: 0 }), "Nothing to take off.");
});

test("pick a commit: undo goes back past it, Put back restores with that undo's n, and a refusal says why and keeps the sheet", async () => {
  const calls = [];
  let refuse = true;
  const s = undoSheet({ load: async () => ({ data: H }), onClose() {},
    undo: async to => { calls.push(["undo", to]); return { data: { undone: 2, n: 4, kept_unsaved: true } }; },
    redo: async n => { calls.push(["redo", n]); return refuse ? { error: { message: "The session has moved on since." } } : { data: { redone: 4 } }; } });
  await s.load();
  assert.equal($$(s.el, "[data-undo]").length, 4);
  assert.match(text(s.el), /2 files not yet saved will be kept first/);
  $(s.el, "[data-undo=c2]").dispatchEvent(ev("click")); await settle();
  assert.deepEqual(calls, [["undo", "c2"]]);
  assert.match(text(s.el), /Took off 2 changes, and kept your unsaved work/);
  $(s.el, "[data-act=redo]").dispatchEvent(ev("click")); await settle();
  assert.deepEqual(calls.at(-1), ["redo", 4]);
  assert.match(text(s.el), /moved on since/);
  assert.ok($(s.el, "[data-act=redo]"), "still there to try again");
  refuse = false;
  $(s.el, "[data-act=redo]").dispatchEvent(ev("click")); await settle();
  assert.equal($(s.el, "[data-act=redo]"), null);
});

test("Everything sends no commit and a server without the tool says there is nothing of its own to undo", async () => {
  const calls = [];
  const s = undoSheet({ load: async () => ({ data: H }), onClose() {}, undo: async to => { calls.push(to); return { data: { undone: 3, n: 1 } }; }, redo: async () => ({ data: {} }) });
  await s.load();
  $(s.el, "[data-undo=all]").dispatchEvent(ev("click")); await settle();
  assert.deepEqual(calls, [null]);
  const g = undoSheet({ load: async () => ({ error: { message: "x has no git repo" } }), onClose() {}, undo: async () => ({}), redo: async () => ({}) });
  await g.load();
  assert.match(text(g.el), /no changes of its own to undo/);
});
