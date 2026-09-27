// @ts-check
// Which sessions tools this box has, learnt from the first answer each gives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaps, isMissing, NEEDS_UPDATE, SESSION_TOOLS, NOT_OFFERED, SEND_IMAGES, REWIND_CODE, CAPS } from "./caps.js";

test("a tool is unknown until asked, there once it answers, missing once it is no such tool (and never called again)", async () => {
  const caps = createCaps();
  const heard = [];
  const off = caps.on((tool, ok) => heard.push([tool, ok]));
  assert.equal(caps.has("threads.mode"), null);
  let calls = 0;
  const missing = async () => { calls++; return { error: { code: "no_such_tool", message: "no such tool here" } }; };
  const r = await caps.use("threads.mode", missing);
  assert.equal(r.missing, true);
  assert.equal(caps.has("threads.mode"), false);
  const again = await caps.use("threads.mode", missing);
  assert.equal(calls, 1, "not called again");
  assert.equal(again.error.message, NEEDS_UPDATE);
  const ok = await caps.use("threads.model", async () => ({ data: { model: "sonnet" } }));
  assert.deepEqual(ok, { data: { model: "sonnet" } });
  assert.equal(caps.has("threads.model"), true);
  const other = await caps.use("threads.rewind", async () => ({ error: { code: "not_found", message: "no such message" } }));
  assert.equal(other.missing, undefined, "a missing message is not a missing tool");
  assert.equal(caps.has("threads.rewind"), null);
  off();
  caps.set("threads.edit", true);
  assert.deepEqual(heard, [["threads.mode", false], ["threads.model", true], [REWIND_CODE, true]], "rewind's code restore came with threads.model");
});

test("what counts as missing", () => {
  assert.equal(isMissing({ code: "no_such_tool" }), true);
  assert.equal(isMissing({ code: "http_404" }), true);
  assert.equal(isMissing({ code: "offline", missing: true }), false, "a box that did not answer is not a verdict");
  assert.equal(isMissing({ code: "no_such_tool", missing: true }), true);
  assert.equal(isMissing({ code: "not_found", message: "no tool threads.edit" }), true);
  assert.equal(isMissing({ code: "not_found", message: "no such thread" }), false);
  assert.equal(isMissing({ code: "busy" }), false);
  assert.equal(isMissing(null), false);
  assert.ok(SESSION_TOOLS.includes("threads.send-now"));
  assert.ok(!SESSION_TOOLS.includes("threads.send_now"));
});

test("the final contract: its tools are learnt, what it does not offer starts off and is never called", async () => {
  for (const gone of ["threads.steer", "threads.checkpoints", "threads.tasks"]) assert.ok(!SESSION_TOOLS.includes(gone), gone);
  for (const t of ["threads.interrupt", "threads.unqueue", "threads.edit", "threads.rewind", "threads.mode", "threads.model", "threads.commands", "sessions.models.get"]) {
    assert.ok(SESSION_TOOLS.includes(t), t);
    assert.ok(!NOT_OFFERED.includes(t), t);
    assert.equal(CAPS.has(t), null, "live tools are asked, not assumed");
  }
  assert.equal(CAPS.has(REWIND_CODE), null, "rewind's code restore is learnt too");
  for (const t of ["threads.shell", "threads.remember", "threads.thinking", "threads.kill-task", SEND_IMAGES]) {
    assert.ok(NOT_OFFERED.includes(t), t);
    assert.equal(CAPS.has(t), false, t);
  }
  const caps = createCaps({ off: ["threads.shell"] });
  let calls = 0;
  const r = await caps.use("threads.shell", async () => { calls++; return { data: {} }; });
  assert.equal(calls, 0);
  assert.equal(r.missing, true);
  assert.equal(createCaps().has("threads.shell"), null, "a probe of its own starts empty");
});

test("rewind's code restore is learnt from threads.commands or threads.model: an older box turns it off with them", async () => {
  const caps = createCaps();
  await caps.use("threads.commands", async () => ({ error: { code: "no_such_tool", message: "no tool threads.commands" } }));
  assert.equal(caps.has(REWIND_CODE), false);
  const again = createCaps();
  await again.use("threads.commands", async () => ({ data: { thread: "t1", commands: [], note: "not running" } }));
  assert.equal(again.has(REWIND_CODE), true);
  const other = createCaps();
  await other.use("threads.commands", async () => ({ error: { code: "not_found", message: "no such thread" } }));
  assert.equal(other.has(REWIND_CODE), null, "a missing thread says nothing about the box");
});
