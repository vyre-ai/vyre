// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, frame, toEnvelope, blockFor, validBlock, KINDS, BLOCKS, startOf, termChunks, resetFrame, heartbeatFrame, summarize } from "./protocol.js";

const ctx = { session: "thr_1", turn: "3", cur: 7, time: 1000, id: "id-1" };
const good = {
  "text-delta": { message: "m1", index: 0, text: "hi" },
  "text-done": { message: "m1" },
  "tool-started": { tool_id: "t1", tool: "Bash", kind: "shell", summary: "ls" },
  "tool-progress": { tool_id: "t1", text: "half", pct: 50 },
  "tool-finished": { tool_id: "t1", ok: true, result: { block: "text", text: "done" } },
  "term-chunk": { term: "t_1", offset: 0, b64: "aGk=" },
  "term-command": { term: "t_1", command: "ls" },
  "file-changed": { path: "a.js", op: "edit" },
  "ask": { ask_id: "a1", kind: "permission" },
  "ask-answered": { ask_id: "a1", decision: "allow" },
  "user-message": { message: "u1", text: "go", state: "queued", queued_at: 5 },
  "status": { state: "working", turn: "3" },
  "participant-joined": { who: "assistant:kit" },
  "participant-left": { who: "person:alex" },
  "reaction": { message: "m", emoji: "x", on: true },
  "pin": { message: "m", on: true },
  "mention": { message: "m", who: ["assistant:kit"] },
  "fanout": { group: "g", message: "q", members: [{ who: "model:a", message: "a1" }, { who: "model:b", message: "a2" }] },
  "fanout-keep": { group: "g", keep: "a1" },
  "step-summary": { step: "kit#1", count: 3, kinds: { read: 2, shell: 1 }, summary: "Read 2 files, ran a command", ok: true },
  "text-cut": { message: "m", note: "n" },
};

test("protocol: every kind validates with its data and is refused without it", () => {
  for (const k of KINDS) {
    const f = frame(k, good[/** @type {keyof typeof good} */ (k)], ctx);
    assert.deepEqual(validate(f), { ok: true }, k);
    assert.equal(f.type, `chat.${k}`);
    assert.equal(f.corr, "3");
    assert.equal(validate({ ...f, data: {} }).ok, false, `${k} with empty data`);
  }
  assert.equal(KINDS.length, 21);
});

test("protocol: a hidden stub keeps a cursor and holds nothing", () => {
  const stub = { v: 1, id: "h", cur: 4, session: "s", turn: null, type: "chat.hidden", time: 1, corr: null, data: {} };
  assert.deepEqual(validate(stub), { ok: true });
  assert.equal(validate({ ...stub, data: { text: "x" } }).ok, false);
  assert.equal(validate({ ...stub, cur: 0 }).ok, false);
});

test("protocol: envelope fields are checked", () => {
  const f = frame("status", good.status, ctx);
  assert.equal(validate({ ...f, v: 2 }).ok, false);
  assert.equal(validate({ ...f, cur: 0 }).ok, false, "a logged frame has a cursor from 1");
  assert.equal(validate({ ...f, type: "thread.status" }).ok, false);
  assert.equal(validate({ ...f, type: "chat.nope" }).ok, false);
  assert.equal(validate({ ...f, id: "" }).ok, false);
  assert.equal(validate({ ...f, data: { state: "dancing" } }).ok, false);
  assert.equal(validate(null).ok, false);
  assert.equal(validate({ ...f, span: 2 }).ok, false, "a span needs one part per cursor");
  const t = frame("text-delta", { message: "m", index: 0, text: "ab", parts: [1, 1] }, { ...ctx, cur: 9 });
  assert.deepEqual(validate({ ...t, span: 2 }), { ok: true });
  assert.equal(startOf({ ...t, span: 2 }), 8);
});

test("protocol: control frames carry no cursor", () => {
  assert.deepEqual(validate(resetFrame("s", "behind", 9)), { ok: true });
  assert.deepEqual(validate(heartbeatFrame("s", 9)), { ok: true });
  assert.equal(validate({ ...heartbeatFrame("s", 9), cur: 4 }).ok, false);
  assert.throws(() => frame("nope", {}, ctx));
});

test("toEnvelope: a frame lifts to the kernel envelope shape, subject is the session, corr the turn", () => {
  const f = frame("tool-finished", good["tool-finished"], ctx);
  const e = toEnvelope(f, { space: "harlow" });
  assert.equal(e.v, 1);
  assert.equal(e.type, "chat.tool-finished");
  assert.match(e.type, /^[a-z]+\.[a-z]+(-[a-z]+)*$/, "noun.past-verb, two segments");
  assert.equal(e.subject, "urn:vyre:session:thr_1");
  assert.equal(e.corr, "3");
  assert.equal(e.space, "harlow");
  assert.deepEqual(e.data, f.data);
  assert.equal(e.id, "id-1");
  for (const k of ["seq", "sv", "time", "received_at", "actor", "chain", "trust", "source_spaces", "vis", "red", "commit", "prev", "hash"]) assert.ok(k in e, k);
});

test("blockFor: Bash is a terminal block with the command and the end of its output", () => {
  const out = "line\n".repeat(5000) + "done\nexit code: 2";
  const b = blockFor("Bash", { command: "npm test" }, out);
  assert.equal(b.block, "terminal");
  assert.equal(b.command, "npm test");
  assert.equal(b.exit, 2);
  assert.ok(b.output.length < 6400 && b.output.endsWith("exit code: 2"), "cut from the front: the end of a run is what matters");
  assert.match(b.output, /characters earlier/);
});

test("blockFor: Edit, Write and MultiEdit are diffs", () => {
  const e = blockFor("Edit", { file_path: "src/order.js", old_string: "a", new_string: "b" }, "ok");
  assert.deepEqual(e, { block: "diff", path: "src/order.js", hunks: [{ del: "a", add: "b" }] });
  const w = blockFor("Write", { file_path: "new.js", content: "x" }, "");
  assert.equal(w.block, "diff");
  assert.equal(w.created, true);
  const m = blockFor("MultiEdit", { file_path: "f", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] }, "");
  assert.equal(m.hunks.length, 2);
});

test("blockFor: Read, Grep and Glob are file lists; TodoWrite is a task list", () => {
  assert.deepEqual(blockFor("Read", { file_path: "a.md" }, "").files, [{ path: "a.md" }]);
  const g = blockFor("Grep", { pattern: "total" }, "src/a.js:12:  const total = 1\nsrc/b.js:3:total()");
  assert.equal(g.block, "files");
  assert.deepEqual(g.files[0], { path: "src/a.js", line: 12, text: "const total = 1" });
  const gl = blockFor("Glob", { pattern: "*.js" }, "a.js\nb.js\n");
  assert.equal(gl.files.length, 2);
  const t = blockFor("TodoWrite", { todos: [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }, { content: "three", status: "pending" }] }, "");
  assert.deepEqual(t.items.map(/** @param {any} i */ i => i.status), ["done", "running", "pending"]);
});

test("blockFor: an unknown tool becomes a short text summary, never a JSON dump", () => {
  for (const [tool, input, output] of /** @type {[string, any, any][]} */ ([
    ["mcp__crm__lookup", { query: "Harlow Legal", limit: 5, nested: { a: [1, 2, 3] } }, { rows: [{ id: 1 }, { id: 2 }] }],
    ["Mystery", { a: 1 }, undefined],
    ["Mystery", null, [{ type: "text", text: "found two matters" }]],
  ])) {
    const b = blockFor(tool, input, output);
    assert.equal(b.block, "text");
    assert.ok(b.text.length > 0 && b.text.length <= 401);
    assert.doesNotMatch(b.text, /^\s*[\[{]/, "does not start as JSON");
    assert.doesNotMatch(b.text, /"rows"|"nested"/);
  }
  assert.equal(blockFor("Mystery", null, [{ type: "text", text: "found two matters" }]).text, "found two matters");
  assert.match(summarize("mcp__crm__lookup", { query: "x" }), /query: x/);
});

test("blockFor: secrets are redacted in every block", () => {
  const key = "sk-live-" + "a1B2c3D4e5F6g7H8i9J0k1L2";
  const b = blockFor("Bash", { command: `curl -H "Authorization: Bearer ${key}" x` }, `token ${key}`);
  assert.ok(!JSON.stringify(b).includes(key));
  assert.match(b.output, /redacted/);
  const d = blockFor("Write", { file_path: ".env", content: `KEY=${key}` }, "");
  assert.ok(!JSON.stringify(d).includes(key));
});

test("validBlock: every block name is known, and a block needs its own props", () => {
  assert.equal(BLOCKS.length, 12);
  assert.equal(validBlock({ block: "text", text: "x" }), true);
  assert.equal(validBlock({ block: "text" }), false);
  assert.equal(validBlock({ block: "nonsense" }), false);
  assert.equal(validBlock({ block: "diff", path: "a", hunks: [] }), true);
  assert.equal(validBlock({ block: "record", whatever: 1 }), true);
});

test("termChunks: bytes become consecutive offsets", () => {
  const bytes = Buffer.alloc(40000, 65);
  const cs = termChunks("t_1", 100, bytes, 16384);
  assert.deepEqual(cs.map(c => c.data.offset), [100, 100 + 16384, 100 + 32768]);
  assert.equal(Buffer.concat(cs.map(c => Buffer.from(c.data.b64, "base64"))).length, 40000);
});

test("a cited field is a field-ref block: record and field, never a value; a reply carries it in text-done blocks", () => {
  const ref = { block: "field-ref", record: "vyre://spc/matter/1", field: "fee", label: "Fee" };
  assert.equal(validBlock(ref), true);
  assert.equal(validBlock({ ...ref, value: "4200" }), false, "a ref carries no value");
  assert.equal(validBlock({ block: "field-ref", record: "r" }), false);
  const f = { v: 1, id: "i", cur: 1, time: 1, turn: null, corr: null, session: "s", type: "chat.text-done", author: "assistant:kit", data: { message: "m", blocks: [ref] } };
  assert.equal(validate(f).ok, true);
  assert.equal(validate({ ...f, data: { message: "m", blocks: [{ block: "nope" }] } }).ok, false);
});
