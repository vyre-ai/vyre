// @ts-check
// Undo per file (R031-53): a file a turn edited or wrote is put back as it was, only while it still holds the turn's result, only inside the session's folder, and the session is told.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEdits, registerEdits, KEEP } from "./edits.js";
import { SCRATCH } from "../../test/scratch.mjs";

const dir = t => { const d = fs.mkdtempSync(path.join(SCRATCH, "vyre-edits-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return fs.realpathSync(d); };
const started = (e, thread, call, kind, file) => e.started(thread, { phase: "started", call, kind, path: file });
const finished = (e, thread, call, ok = true) => e.finished(thread, { phase: "done", call, status: ok ? "completed" : "failed", error: !ok });

test("an edit is put back as it was before the turn, and a second undo has nothing to do", t => {
  const d = dir(t), file = path.join(d, "a.txt");
  fs.writeFileSync(file, "one\n");
  const e = createEdits({ cwdOf: () => d });
  started(e, "t1", "c1", "edit", "a.txt"); fs.writeFileSync(file, "two\n"); finished(e, "t1", "c1");
  started(e, "t1", "c2", "edit", file); fs.writeFileSync(file, "three\n"); finished(e, "t1", "c2");
  assert.equal(e.has("t1", "a.txt"), true);
  assert.deepEqual(e.undo("t1", "a.txt"), { path: "a.txt", restored: "put back" });
  assert.equal(fs.readFileSync(file, "utf8"), "one\n", "from before the FIRST edit of the turn");
  assert.throws(() => e.undo("t1", "a.txt"), { code: "not_found" });
  assert.equal(e.has("t1", "a.txt"), false);
});

test("a file the turn made is removed again; a file changed since is left alone", t => {
  const d = dir(t), made = path.join(d, "new.txt"), kept = path.join(d, "kept.txt");
  fs.writeFileSync(kept, "before");
  const e = createEdits({ cwdOf: () => d });
  started(e, "t1", "w", "write", "new.txt"); fs.writeFileSync(made, "made"); finished(e, "t1", "w");
  started(e, "t1", "k", "edit", "kept.txt"); fs.writeFileSync(kept, "after"); finished(e, "t1", "k");
  assert.equal(e.undo("t1", "new.txt").restored, "removed");
  assert.equal(fs.existsSync(made), false);
  fs.writeFileSync(kept, "the person typed this");
  assert.throws(() => e.undo("t1", "kept.txt"), { code: "conflict" });
  assert.equal(fs.readFileSync(kept, "utf8"), "the person typed this", "nothing was overwritten");
});

test("only the latest turn's edit of a file is put back, and only inside the folder", t => {
  const d = dir(t), file = path.join(d, "a.txt"), out = dir(t);
  fs.writeFileSync(file, "v1");
  const e = createEdits({ cwdOf: () => d });
  started(e, "t1", "c1", "edit", "a.txt"); fs.writeFileSync(file, "v2"); finished(e, "t1", "c1"); e.turnEnded("t1");
  started(e, "t1", "c2", "edit", "a.txt"); fs.writeFileSync(file, "v3"); finished(e, "t1", "c2"); e.turnEnded("t1");
  e.undo("t1", "a.txt");
  assert.equal(fs.readFileSync(file, "utf8"), "v2", "the last turn only");
  e.undo("t1", "a.txt");
  assert.equal(fs.readFileSync(file, "utf8"), "v1");
  fs.writeFileSync(path.join(out, "x.txt"), "x");
  started(e, "t1", "c3", "edit", path.join(out, "x.txt")); fs.writeFileSync(path.join(out, "x.txt"), "y"); finished(e, "t1", "c3");
  assert.throws(() => e.undo("t1", path.join(out, "x.txt")), { code: "denied" }, "a file outside the session's folder is not put back from here");
  fs.symlinkSync(out, path.join(d, "link"));
  assert.throws(() => e.undo("t1", "link/x.txt"), { code: "denied" }, "a link out of the folder is outside it");
  assert.throws(() => e.undo("t9", "a.txt"), { code: "not_found" });
});

test("a failed call, a call that is not an edit, a large file and a restart keep nothing to put back", t => {
  const d = dir(t), file = path.join(d, "a.txt"), big = path.join(d, "big.bin");
  fs.writeFileSync(file, "one"); fs.writeFileSync(big, Buffer.alloc(KEEP.preBytes + 1));
  const e = createEdits({ cwdOf: () => d });
  started(e, "t1", "c1", "edit", "a.txt"); fs.writeFileSync(file, "two"); finished(e, "t1", "c1", false);
  started(e, "t1", "c2", "run", "a.txt"); finished(e, "t1", "c2");
  started(e, "t1", "c3", "edit", "big.bin"); fs.writeFileSync(big, Buffer.alloc(KEEP.preBytes + 2)); finished(e, "t1", "c3");
  assert.throws(() => e.undo("t1", "a.txt"), { code: "not_found" });
  assert.throws(() => e.undo("t1", "big.bin"), { code: "unavailable" });
  assert.throws(() => createEdits({ cwdOf: () => null }).undo("t1", "a.txt"), { code: "unavailable" });
});

test("the tool is a person's, puts the file back and tells the session", async t => {
  const d = dir(t), file = path.join(d, "a.txt");
  fs.writeFileSync(file, "one");
  /** @type {Record<string, Function>} */ const handlers = {};
  const told = [], emitted = [];
  const ctx = { events: { on: (/** @type {string} */ type, /** @type {Function} */ fn) => { handlers[type] = fn; return () => {}; }, emit: (/** @type {string} */ ...a) => emitted.push(a) } };
  let run;
  const reg = registerEdits({ ctx, tool: (/** @type {string} */ _n, /** @type {string} */ _d, /** @type {any} */ _s, /** @type {Function} */ fn) => { run = fn; }, guard: (/** @type {string} */ c) => { if (/^mcp/.test(c)) throw Object.assign(new Error("no"), { code: "denied" }); }, queuesFor: (/** @type {string} */ c) => c === "deck", cwdOf: () => d, tell: (/** @type {string} */ id, /** @type {string} */ n) => told.push([id, n]) });
  handlers["thread.tool"]({ thread: "t1", payload: { phase: "started", call: "c1", kind: "edit", path: "a.txt" } });
  fs.writeFileSync(file, "two");
  handlers["thread.tool"]({ thread: "t1", payload: { phase: "done", call: "c1", status: "completed" } });
  await assert.rejects(run({ thread: "t1", path: "a.txt" }, { caller: "mcp" }), { code: "denied" });
  await assert.rejects(run({ thread: "t1", path: "a.txt" }, { caller: "cli" }), { code: "denied" });
  const r = await run({ thread: "t1", path: "a.txt" }, { caller: "deck" });
  assert.deepEqual(r, { path: "a.txt", restored: "put back" });
  assert.equal(fs.readFileSync(file, "utf8"), "one");
  assert.match(String(told[0][1]), /the person undid your last edit to a\.txt: it is back as it was before your turn/);
  assert.equal(told[0][0], "t1");
  assert.deepEqual(emitted[0].slice(0, 3), ["thread.edit-undone", { path: "a.txt", restored: "put back" }, { thread: "t1" }]);
  reg.stop();
});
