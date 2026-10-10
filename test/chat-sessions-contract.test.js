// The contract between the sessions layer (core/switchboard, core/sessions) and Chat (the app's chat core,
// apps/app/src/chat and src/session), checked from the source on both sides so a rename on either fails here first.
//
// Server side: every tool("name", ...) registered under core/ and every event name emitted there.
// Chat side: every "threads.*" / "sessions.*" tool name chat's code names, every event name it
// listens for or reduces, and caps.js's lists. A name chat uses must exist on the server, unless
// caps.js says the server does not offer it yet (NOT_OFFERED); then the control starts off. There is no
// other excuse: an event chat hears is emitted, or the listener goes.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_OFFERED, SESSION_TOOLS } from "../apps/app/src/chat/core/caps.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every .js file under dir, tests left out. @param {string} dir */
function sources(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "fixtures" && e.name !== "testing" && e.name !== "vendor") out.push(...sources(rel)); }
    else if (/\.(js|ts|tsx)$/.test(e.name) && !/\.(test\.js|d\.ts)$/.test(e.name)) out.push(rel);
  }
  return out;
}
/** @param {string[]} files @param {RegExp} re */
function names(files, re) {
  const set = new Set();
  for (const f of files) for (const m of fs.readFileSync(path.join(root, f), "utf8").matchAll(re)) set.add(m[1]);
  return set;
}
const read = f => fs.readFileSync(path.join(root, f), "utf8");

// the server side is core/ and the lib/ files the switchboard emits through (lib/lent-placement.js says thread.placing)
const core = [...sources("core"), ...sources("lib")];
const serverTools = names(core, /\btool\(\s*"([a-z]+\.[a-z.-]+)"/g);
// an event is emitted by emit("x.y", ...) or built as an event object ({ type: "x.y", ... }), as the plan is
const serverEvents = new Set([...names(core, /\b(?:emit|emitRaw|fire)\??\.?\(\s*"([a-z]+\.[a-z._-]+)"/g), ...names(core, /\btype:\s*"((?:thread|ask|mode|model|thinking)\.[a-z._-]+)"/g)]);

const chat = [...sources("apps/app/src/chat"), ...sources("apps/app/src/session"), ...sources("apps/app/screens/chat-tools")];
const chatTools = names(chat, /"((?:threads|sessions)\.[a-z_-]+(?:\.[a-z_-]+)*)(?::[a-z]+)?"/g);
// A name the app passes to `tool(...)` (ask.answer) is a tool the server has, not an event it must emit.
const chatEvents = new Set([...names(chat, /"((?:thread|ask|mode|model|thinking)\.[a-z_-]+)"/g)].filter(e => !serverTools.has(e)));


test("the sessions layer is on this tree (merge pre/3a first)", () => {
  assert.ok(serverTools.has("threads.send"), "core registers threads.send");
  assert.ok(serverEvents.has("thread.steered"), "core emits thread.steered: the sessions layer (ADR 0030) is missing");
});

test("no tool name uses an underscore: the registry refuses it", () => {
  for (const t of [...chatTools, ...NOT_OFFERED].map(String)) assert.ok(!/_/.test(t.split(":")[0]), `${t} has an underscore; the server names tools with dashes`);
});

test("every live tool chat calls is registered on the server", () => {
  const future = new Set(NOT_OFFERED.map(t => String(t).split(":")[0]));
  const missing = [...chatTools].filter(t => !serverTools.has(t) && !future.has(t) );
  assert.deepEqual(missing, [], `chat calls tools the server does not register: ${missing.join(", ")}`);
  for (const t of SESSION_TOOLS) assert.ok(serverTools.has(t), `caps.js says ${t} is live, the server lacks it`);
});

test("a tool in NOT_OFFERED that the server now has is switched on", () => {
  const shipped = NOT_OFFERED.map(String).filter(t => !t.includes(":") && serverTools.has(t));
  assert.deepEqual(shipped, [], `the server offers ${shipped.join(", ")}: take them out of caps.js NOT_OFFERED`);
});

test("every event chat listens for is emitted, or is a known future one", () => {
  const missing = [...chatEvents].filter(e => !serverEvents.has(e));
  assert.deepEqual(missing, [], `chat listens for events nobody emits: ${missing.join(", ")}`);
});

test("chat hears every session event the sessions layer emits", () => {
  const needed = ["thread.started", "thread.turn", "thread.text", "thread.tool", "thread.finished", "thread.stopped", "thread.state",
    "thread.usage", "thread.limit", "thread.sent", "thread.queued", "thread.unqueued", "thread.steered", "thread.rewound",
    "ask.raised", "ask.answered", "mode.changed", "model.changed", "model.switched",
    "thread.task", "thread.thinking", "thinking.switched", "thread.shell", "thread.remembered"];
  for (const e of needed) {
    assert.ok(serverEvents.has(e), `the server no longer emits ${e}: update this test and chat together`);
    assert.ok(chatEvents.has(e), `chat does not listen for ${e}`);
  }
});

test("the payload fields chat keys on are the ones the server sends", () => {
  const sb = read("core/switchboard/index.js");
  const tr = read("core/switchboard/translate.js");
  const st = read("apps/app/src/chat/core/session-state.js");
  const comp = read("apps/app/src/chat/composer-model.js") + read("apps/app/src/chat/real-composer.js");
  // The queue: the send answer names the row queued_id; events name it queued.
  assert.match(sb, /queued_id\b/, "threads.send answers queued_id");
  assert.match(comp + st, /queued_id\b/, "chat reads queued_id from the send answer");
  // Steering and the queue hand-over say how they were sent.
  for (const via of ["steer", "turn", "now"]) {
    assert.match(sb, new RegExp(`via: "${via}"`), `thread.sent via "${via}"`);
    assert.match(st, new RegExp(`"${via}"`), `chat handles via "${via}"`);
  }
  // Live keys: text by message and block, tools by call, with the final statuses.
  assert.match(tr + sb, /\bblock\b/, "thread.text carries block");
  assert.match(sb + tr, /\bcall\b/, "thread.tool carries call");
  for (const s of ["canceled", "failed"]) assert.match(sb + tr, new RegExp(`"${s}"`), `the server says ${s}`);
  assert.match(st, /"canceled"/, "chat draws canceled tools");
  assert.match(st, /"failed"/, "chat draws the failed state");
  // Rewind in place: the answer's text comes back to the composer.
  assert.match(sb, /rewound: true, id, thread: id, uuid, text/, "threads.rewind answers { rewound, id, thread, uuid, text }");
  // Asks anchor to their tool row.
  assert.match(sb + tr, /tool_use_id/, "ask.raised carries tool_use_id");
  // Per-turn cost, never the running total, on a turn.
  assert.match(sb, /total_cost_usd/, "thread.usage carries total_cost_usd beside cost_usd");
  // The ahead keys, strict once core has them: rewind's restore and files, commands' shape, the context share.
  assert.match(st, /files_changed/, "chat counts the restored files");
  assert.match(st, /\bshare\b/, "chat reads the context share");
  assert.match(read("apps/app/src/chat/core/commands.js"), /argumentHint/, "chat reads a command's argumentHint");
  if (serverTools.has("threads.model")) {
    assert.match(sb, /files_changed/, "threads.rewind answers files {restored, files_changed}");
    assert.match(sb, /enum: \["conversation", "code", "both"\]/, "threads.rewind takes restore conversation, code or both");
    assert.match(sb, /argumentHint/, "threads.commands answers {name, description, argumentHint}");
    assert.match(sb, /"model.switched", \{ model:/, "model.switched carries model");
  }
  if (/context: \{ used/.test(sb)) assert.match(sb, /share:/, "thread.usage context carries share");
});

test("sessions 034c71e5's shapes: images, ! shell, # memory, thinking, background tasks", () => {
  const sb = read("core/switchboard/index.js");
  const tr = read("core/switchboard/translate.js");
  const st = read("apps/app/src/chat/core/session-state.js");
  // Chat's side: the session state the app's chat core keeps. (The Deck's composer and session view that these checked for images, ! shell, # memory, thinking and background tasks are gone; the app's composer is covered by apps/app/src/chat/composer-model.test.js.)
  assert.match(st, /p\.kind === "reasoning" \? "reasoning"/, "chat keys reasoning apart from text");
  assert.match(st, /case "thread\.thinking": onText\(s, \{ \.\.\.p, kind: "reasoning"/, "thread.thinking is a reasoning row");
  assert.match(st, /prefix = kind === "reasoning" \? "r" : "m"/, "reasoning is r:<message>:<block>, text m:<message>:<block>");
  for (const f of ["summary", "background", "call", "error"]) assert.match(st, new RegExp(`p\\.${f}\\b`), `chat reads thread.task's ${f}`);
  assert.match(st, /p\.code/, "chat reads thread.shell's code");
  // The server's side, once core has the release (strict then).
  if (!serverTools.has("threads.shell")) return;
  assert.match(sb, /images: \{ type: "array", items: \{ type: "object", required: \["media_type", "data"\]/, "threads.send takes images [{media_type, data}]");
  assert.match(sb, /IMAGES = \{ count: 5, mb: 5 \}/, "the box's image caps are chat's");
  assert.match(sb, /IMAGE_TYPES = \["image\/png", "image\/jpeg", "image\/gif", "image\/webp"\]/, "the image types are chat's");
  assert.match(sb, /images: images\.length/, "thread.sent counts the images");
  assert.match(sb, /required: \["thread", "command"\]/, "threads.shell takes {thread, command}");
  assert.match(sb, /"thread\.shell", \{ command: .*, code: r\.code, output:/, "thread.shell carries {command, code, output}");
  assert.match(sb, /return \{ thread: id, code: r\.code, output: out/, "threads.shell answers {code, output}");
  assert.match(sb, /enum: \["project", "user", "local"\]/, "threads.remember scopes");
  assert.match(sb, /"thread\.remembered", \{ scope, file \}/, "thread.remembered carries {scope, file}");
  assert.match(sb, /required: \["thread", "on"\]/, "threads.thinking takes {thread, on}");
  assert.match(sb, /"thinking\.switched", \{ on:/, "thinking.switched carries on");
  assert.match(sb, /return \{ thread: id, thinking: Boolean\(on\) \}/, "threads.thinking answers {thinking}");
  assert.match(sb, /required: \["thread", "task"\]/, "threads.kill-task takes {thread, task}");
  assert.match(sb, /"thread\.task", task,/, "thread.task is the task itself");
  assert.match(sb, /tasks: st && st\.tasks \?/, "threads.tasks answers {tasks}");
  for (const f of ["kind:", "title:", "call:", "background:", "summary:", "error:"]) assert.ok(tr.includes(f), `thread.task has ${f}`);
  assert.match(tr, /"killed"/, "a stopped task is killed");
  // Thinking: thread.thinking (db44749b) or, on 034c71e5, thread.text kind "reasoning".
  assert.match(sb + tr, /"thread\.thinking", \{ message:|type: "thread\.thinking", payload: \{ message: id, block, text:|kind: "reasoning"/, "thinking carries message and block");
});
