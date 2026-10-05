// @ts-check
// The CLI verbs for Vyre-owned sessions (docs/adr/0030-sessions.md): `vyre threads` interrupt,
// mode, queue, take-back, edit, send-now, rewind, open and one-shot get, a watch that reconnects
// without repeating itself, and `vyre sessions`. The pure parts first; then a real vyred in a temp
// home with the fake Claude, the CLI as a child with pipes and no terminal, as a script runs it.
//
// The same file runs against a vyred that has the sessions tools and one that does not yet. Each
// verb whose tool is missing must say what is coming in one line and exit 1; one whose tool is
// there must do its job. Which vyred this is comes from its own tool list, never a guess.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call, request } from "../../daemon/client.js";
import { tempHome, present } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";
import { formatEvent, pendingQueue, sendArgs, queuedId, usageLine, watchBackoff, MODES,
  routeLine, imagesFrom, rewindTurns, turnFor, modelOf, IMAGES } from "./threads.js";
import { modelScope, promptScope, previewInput } from "./sessions.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "..", "..", "bin", "vyre");
const FAKE = path.join(HERE, "..", "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);
const plain = s => (s == null ? s : s.replace(/\x1b\[[0-9;]*m/g, ""));
/** The composer's tools the CLI drives (chat parity). */
const PARITY = ["threads.model", "threads.thinking", "threads.commands", "threads.shell", "threads.remember", "threads.tasks", "threads.kill-task", "threads.rewind"];

/** A 1x1 PNG, for a message with a picture. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// ------------------------------------------------------------ pure parts

test("sendArgs: --queue and --steer before the text say how; later ones are words", () => {
  const plainSend = { raw: false, images: [], error: null };
  assert.deepEqual(sendArgs(["a1b2", "draft", "the", "menu"]), { how: null, ref: "a1b2", words: ["draft", "the", "menu"], ...plainSend });
  assert.deepEqual(sendArgs(["--queue", "a1b2", "draft"]), { how: "queue", ref: "a1b2", words: ["draft"], ...plainSend });
  assert.deepEqual(sendArgs(["a1b2", "--steer", "also", "the", "prices"]), { how: "steer", ref: "a1b2", words: ["also", "the", "prices"], ...plainSend });
  assert.deepEqual(sendArgs(["a1b2", "use", "--queue", "here"]), { how: null, ref: "a1b2", words: ["use", "--queue", "here"], ...plainSend });
  assert.deepEqual(sendArgs(["a1b2", "--", "--queue", "is", "a", "flag"]).words, ["--queue", "is", "a", "flag"]);
  assert.equal(sendArgs(["--queue", "a1b2", "--steer", "x"]).how, "both");
});

test("sendArgs: --image repeats, --raw keeps a ! or # as words, a bare --image is a mistake", () => {
  assert.deepEqual(sendArgs(["a1b2", "--image", "menu.png", "--image=logo.jpg", "--raw", "!not", "a", "shell"]),
    { how: null, ref: "a1b2", words: ["!not", "a", "shell"], raw: true, images: ["menu.png", "logo.jpg"], error: null });
  assert.deepEqual(sendArgs(["a1b2", "--image", "menu.png"]).words, []);
  assert.equal(sendArgs(["a1b2", "--image"]).error, "--image needs a file");
  assert.deepEqual(sendArgs(["a1b2", "see", "--image", "x.png"]).images, [], "after the text it is words");
});

test("routeLine: ! runs, /remember remembers, a leading # is a tag and is sent; raw sends as typed", () => {
  assert.deepEqual(routeLine("!ls -la"), { tool: "threads.shell", body: "ls -la" });
  assert.deepEqual(routeLine("/remember prefer tabs in Harlow Legal's scripts"), { tool: "threads.remember", body: "prefer tabs in Harlow Legal's scripts" });
  assert.deepEqual(routeLine("/remember"), { tool: "threads.remember", body: "" });
  assert.deepEqual(routeLine("/remembering"), { tool: "threads.send", body: "/remembering" });
  assert.deepEqual(routeLine("#GHLapikey to inventory"), { tool: "threads.send", body: "#GHLapikey to inventory" }, "# tags, it no longer remembers");
  assert.deepEqual(routeLine("/remember x", true), { tool: "threads.send", body: "/remember x" });
  assert.deepEqual(routeLine("/compact"), { tool: "threads.send", body: "/compact" });
  assert.deepEqual(routeLine("draft the menu! #2"), { tool: "threads.send", body: "draft the menu! #2" });
  assert.deepEqual(routeLine("!ls", true), { tool: "threads.send", body: "!ls" });
  assert.deepEqual(routeLine("#tag", true), { tool: "threads.send", body: "#tag" });
  assert.deepEqual(routeLine("!"), { tool: "threads.shell", body: "" });
});

test("imagesFrom: type by extension, size and count checked before anything is sent", t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-img-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const png = path.join(dir, "menu.png");
  fs.writeFileSync(png, PNG);
  const [one] = imagesFrom([png]);
  assert.equal(one.media_type, "image/png");
  assert.equal(one.data, PNG.toString("base64"));
  fs.copyFileSync(png, path.join(dir, "logo.JPEG"));
  assert.equal(imagesFrom([path.join(dir, "logo.JPEG")])[0].media_type, "image/jpeg");
  fs.writeFileSync(path.join(dir, "notes.txt"), "hi");
  assert.throws(() => imagesFrom([path.join(dir, "notes.txt")]), /notes\.txt: an image is \.png, \.jpg, \.gif or \.webp/);
  assert.throws(() => imagesFrom([path.join(dir, "gone.png")]), /gone\.png: no such file/);
  const big = path.join(dir, "big.webp");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, IMAGES.mb * 1024 * 1024 + 1);
  assert.throws(() => imagesFrom([big]), /big\.webp is 5\.0 MB; an image is at most 5 MB/);
  assert.throws(() => imagesFrom(Array(IMAGES.count + 1).fill(png)), /at most 5 images in a message; 6 given/);
  assert.equal(imagesFrom(Array(IMAGES.count).fill(png)).length, IMAGES.count);
});

test("rewindTurns: the messages to go back to, numbered, minus what a rewind left behind", () => {
  const turn = (id, uuid, text) => ({ id, at: id * 1000, type: "thread.turn", payload: { turn: "t:" + id, uuid, text } });
  const ev = [
    turn(1, "aaaa1111-0000-4000-8000-000000000001", "draft the Northwind Bakery menu"),
    { id: 2, type: "thread.text", payload: { message: "m", done: true, text: "ok" } },
    turn(3, "bbbb2222-0000-4000-8000-000000000002", "add prices"),
    turn(4, "cccc3333-0000-4000-8000-000000000003", "and the hours"),
    turn(5, "cccc3333-0000-4000-8000-000000000003", "and the hours\n\nSundays too"),
    { id: 6, type: "thread.turn", payload: { turn: "t:6", text: "no uuid" } },
  ];
  const all = rewindTurns(ev);
  assert.deepEqual(all.map(t => [t.n, t.uuid.slice(0, 4), t.text]), [[1, "aaaa", "draft the Northwind Bakery menu"], [2, "bbbb", "add prices"], [3, "cccc", "and the hours\n\nSundays too"]]);
  assert.deepEqual(rewindTurns(ev, 2).map(t => [t.n, t.text]), [[1, "add prices"], [2, "and the hours\n\nSundays too"]]);
  // Rewound to "add prices": it and what came after are gone; a code-only rewind keeps them.
  const back = [...ev, { id: 7, type: "thread.rewound", payload: { uuid: "bbbb2222-0000-4000-8000-000000000002", restore: "conversation" } }];
  assert.deepEqual(rewindTurns(back).map(t => t.text), ["draft the Northwind Bakery menu"]);
  assert.equal(rewindTurns([...ev, { id: 7, type: "thread.rewound", payload: { uuid: "bbbb2222-0000-4000-8000-000000000002", restore: "code" } }]).length, 3);
  assert.deepEqual(rewindTurns([...back, turn(8, "dddd4444-0000-4000-8000-000000000004", "add prices, in dollars")]).map(t => t.n), [1, 2]);
  assert.deepEqual(rewindTurns([]), []);

  assert.deepEqual(turnFor("2", all), { uuid: "bbbb2222-0000-4000-8000-000000000002" });
  assert.match(/** @type {any} */ (turnFor("9", all)).error, /numbered 1 to 3; 9 is not one/);
  assert.deepEqual(turnFor("CCCC", all), { uuid: "cccc3333-0000-4000-8000-000000000003" });
  assert.match(/** @type {any} */ (turnFor("ab", all)).error, /too short/);
  assert.deepEqual(turnFor("eeee5555-0000-4000-8000-000000000005", all), { uuid: "eeee5555-0000-4000-8000-000000000005" }, "not in the window: passed on");
  assert.match(/** @type {any} */ (turnFor("1", [])).error, /no messages to rewind to/);
});

test("modelOf: the record's model, else the last switch in the events", () => {
  assert.equal(modelOf({ thread: { model: "claude-sonnet-4-6" }, events: [{ type: "model.switched", payload: { model: "haiku" } }] }), "claude-sonnet-4-6");
  assert.equal(modelOf({ thread: {}, events: [{ type: "model.switched", payload: { model: "opus" } }, { type: "model.changed", payload: { model: "haiku" } }] }), "haiku");
  assert.equal(modelOf({ thread: {}, events: [] }), null);
});

test("queuedId: the id a queued send came back with, however vyred spells it", () => {
  assert.equal(queuedId({ queued: true, queued_id: 12 }), 12);
  assert.equal(queuedId({ queued: 7 }), 7);
  assert.equal(queuedId({ queued: true }), null);
  assert.equal(queuedId({ sent: true }), null);
});

test("pendingQueue: queued minus handed over, taken back or steered; edits change the text", () => {
  const ev = (type, payload, id) => ({ id, at: id * 1000, type, payload });
  const q = pendingQueue([
    ev("thread.queued", { queued: 1, text: "add the Harlow Legal address", surface: "cli:1" }, 1),
    ev("thread.queued", { queued: 2, text: "and the phone", surface: "deck" }, 2),
    ev("thread.queued", { queued: 3, text: "never mind", surface: "deck" }, 3),
    ev("thread.queued", { queued: 4, text: "the hours too", surface: "cli:1" }, 4),
    ev("thread.sent", { queued: 1, via: "stop", text: "add the Harlow Legal address" }, 5),
    ev("thread.unqueued", { queued: 3 }, 6),
    ev("thread.edited", { queued: 2, text: "and the fax" }, 7),
    ev("thread.text", { message: "m", done: true, text: "ok" }, 8),
  ]);
  assert.deepEqual(q.map(x => [x.queued, x.text]), [[2, "and the fax"], [4, "the hours too"]]);
  assert.deepEqual(pendingQueue([]), []);
});

test("usageLine: tokens, cost and context from whichever fields are there", () => {
  assert.equal(usageLine({ input_tokens: 1200, output_tokens: 34_000, cost_usd: 0.0123, context: { used: 50_000, max: 200_000 } }), "1200 in, 34k out · $0.0123 · context 25%");
  assert.equal(usageLine({ tokens: { input: 10, output: 5 } }), "10 in, 5 out");
  assert.equal(usageLine({ tokens: 900, cost: 0.5, context: 0.4 }), "900 tokens · $0.5000 · context 40%");
  // The sessions shape: this turn's cost and the session's so far.
  assert.equal(usageLine({ cost_usd: 0.01, total_cost_usd: 0.25, tokens: { input: 100, output: 20, cache_read: 5, cache_write: 0 } }), "100 in, 20 out · $0.0100 ($0.2500 so far)");
  assert.equal(usageLine({}), null);
});

test("watchBackoff: 1 s, 2 s, 5 s, then up to 30 s, and 1 s again after a reset", () => {
  const b = watchBackoff();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(() => b.delay()), [1000, 2000, 5000, 10_000, 20_000, 30_000, 30_000, 30_000]);
  b.reset();
  assert.equal(b.delay(), 1000);
});

test("formatEvent: the new session events render, unknown ones are ignored", () => {
  const seen = new Set();
  const f = e => plain(formatEvent(e, seen));
  // A tool call re-emitted with a status shows once when it starts, again only if it fails.
  assert.equal(f({ type: "thread.tool", payload: { call: "c1", name: "Read", status: "running", summary: "Read menu.md" } }), "  · Read menu.md\n");
  assert.equal(f({ type: "thread.tool", payload: { call: "c1", name: "Read", status: "running", summary: "Read menu.md" } }), null);
  assert.equal(f({ type: "thread.tool", payload: { call: "c1", name: "Read", status: "completed" } }), null);
  assert.equal(f({ type: "thread.tool", payload: { call: "c2", name: "Bash", status: "failed", summary: "npm test" } }), "  · npm test failed\n");
  assert.equal(seen.size, 0);
  assert.equal(f({ type: "thread.turn", payload: { turn: "t1:3", text: "hi" } }), "  turn 3\n");
  assert.equal(f({ type: "thread.steered", payload: { text: "also the prices" } }), "  > joined the running turn: also the prices\n");
  assert.equal(f({ type: "thread.queued", payload: { queued: 4, text: "the hours too" } }), "  queued 4: the hours too\n");
  assert.equal(f({ type: "thread.queued", payload: { queued: 4, text: "the hours, and Sundays", edited: true } }), "  changed 4: the hours, and Sundays\n");
  assert.equal(f({ type: "thread.unqueued", payload: { queued: 4 } }), "  took back 4\n");
  assert.equal(f({ type: "thread.usage", payload: { input_tokens: 10, output_tokens: 20 } }), "  10 in, 20 out\n");
  assert.equal(f({ type: "thread.state", payload: { state: "running" } }), null);
  assert.equal(f({ type: "thread.state", payload: { state: "waiting" } }), "  waiting\n");
  assert.equal(f({ type: "thread.state", payload: { state: "failed", error: "the model failed" } }), "  failed: the model failed\n");
  assert.equal(f({ type: "mode.changed", payload: { mode: "plan" } }), "  mode: plan\n");
  assert.equal(f({ type: "thread.finished", payload: { canceled: true, reason: "interrupt" } }), "  interrupted\n");
  assert.match(f({ type: "thread.finished", payload: { error: { code: "x", message: "the model failed" } } }), /failed · the model failed/);
  assert.equal(f({ type: "thread.something-new", payload: { x: 1 } }), null);
});

test("formatEvent: model, thinking, tasks, shell, remember and rewind lines", () => {
  const seen = new Set();
  const f = e => plain(formatEvent(e, seen));
  assert.equal(f({ type: "model.switched", payload: { model: "sonnet", live: true } }), "  model: sonnet\n");
  assert.equal(f({ type: "model.switched", payload: { model: "haiku", live: false } }), "  model: haiku (from its next run)\n");
  assert.equal(f({ type: "model.changed", payload: { model: "opus" } }), "  model: opus\n");
  assert.equal(f({ type: "thinking.switched", payload: { on: false } }), "  thinking: off\n");
  // Thinking shows once per message, and the message's end clears it.
  assert.equal(f({ type: "thread.thinking", payload: { message: "m1", delta: "Let me look at" } }), "  thinking…\n");
  assert.equal(f({ type: "thread.thinking", payload: { message: "m1", delta: " the menu" } }), null);
  assert.equal(f({ type: "thread.text", payload: { message: "m1", delta: "Here" } }), "Here");
  assert.equal(f({ type: "thread.text", payload: { message: "m1", done: true, text: "Here" } }), "\n");
  // A task: when it starts, not on updates, and when it ends.
  assert.equal(f({ type: "thread.task", payload: { id: "task_4", status: "running", kind: "shell", title: "npm run dev" } }), "  · shell task task_4 in the background: npm run dev\n");
  assert.equal(f({ type: "thread.task", payload: { id: "task_4", status: "running", kind: "shell", title: "npm run dev (port 3000)" } }), null);
  assert.equal(f({ type: "thread.task", payload: { id: "task_4", status: "killed", kind: "shell", title: "npm run dev", summary: "stopped by the user" } }), "  · shell task task_4 killed: stopped by the user\n");
  assert.equal(f({ type: "thread.task", payload: { id: "task_5", status: "completed", kind: "agent", title: "review" } }), "  · agent task task_5 completed\n");
  assert.equal(seen.size, 0);
  assert.equal(f({ type: "thread.shell", payload: { command: "ls", code: 0, output: "menu.md\nprices.md\n" } }), "  ! ls\n    menu.md\n    prices.md\n");
  assert.equal(f({ type: "thread.shell", payload: { command: "false", code: 1, output: "" } }), "  ! false\n  exit 1\n");
  assert.equal(f({ type: "thread.remembered", payload: { scope: "local", file: "/work/northwind/CLAUDE.local.md" } }), "  # remembered in CLAUDE.local.md (local)\n");
  assert.equal(f({ type: "thread.rewound", payload: { uuid: "bbbb2222-0000", restore: "conversation", at: "x" } }), "  rewound to bbbb2222\n");
  assert.equal(f({ type: "thread.rewound", payload: { uuid: "bbbb2222-0000", restore: "both", files: { restored: true, files_changed: ["/w/menu.md"] } } }),
    "  rewound to bbbb2222 · the conversation and the files · 1 file put back\n");
  assert.equal(f({ type: "thread.sent", payload: { text: "this one", images: 2, surface: "deck" } }), "  > this one (+2 images)  (deck)\n");
});

test("sessions scopes: a purpose or a project for models; assistant, agent or project for prompts", () => {
  assert.equal(modelScope("chat"), "purpose:chat");
  assert.equal(modelScope("northwind-bakery"), "project:northwind-bakery");
  assert.equal(modelScope("project:chat"), "project:chat");
  assert.equal(promptScope("assistant"), "assistant");
  assert.equal(promptScope("agent:juno"), "agent:juno");
  assert.equal(promptScope("history"), null);
  assert.deepEqual(previewInput("project:harlow-legal"), { project: "harlow-legal" });
  assert.deepEqual(previewInput("assistant"), {});
  assert.deepEqual(MODES, ["default", "acceptEdits", "plan"]);
});

// ------------------------------------------------------------ against a real vyred

/** The CLI as a script runs it: pipes, no controlling terminal. */
function vyre(args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", stdout = "";
    p.stdout.on("data", c => { out += c; stdout += c; }); p.stderr.on("data", c => (out += c));
    p.on("close", code => resolve({ code, out, stdout }));
  });
}

async function until(fn, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise(r => setTimeout(r, 100));
  }
}

/** A vyred in a temp home, running the fake Claude, and the tools it has. */
async function world(t) {
  const root = tempHome(t);
  const was = process.env.VYRE_CLAUDE_BIN;
  process.env.VYRE_CLAUDE_BIN = FAKE;
  t.after(() => { if (was === undefined) delete process.env.VYRE_CLAUDE_BIN; else process.env.VYRE_CLAUDE_BIN = was; });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [], roots: [], vault: { keystore: "file" }, modules: { disable: ["recall", "memory"] } }));
  const boot = () => start({ root, presence: present, log: () => {} });
  const box = { d: await boot() };
  t.after(() => box.d.stop());
  // Outside the home: the security floor treats everything in VYRE_HOME as Vyre's own state.
  const work = fs.mkdtempSync(path.join(SCRATCH, "vyre-work-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const tool = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  const listed = await request("GET", "/v1/tools", null, { root });
  const have = new Set((listed.data || []).map(x => x.name));
  return { root, work, tool, have, env: { VYRE_HOME: root }, box, boot };
}

/** A verb whose tool this vyred lacks: one line naming what is coming, exit 1. */
function coming(r, name) {
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`${name.replace(/\./g, "\\.")} is coming with Vyre-owned sessions \\(ADR 0030\\); this vyred does not have it yet`));
  assert.equal(r.out.trim().split("\n").length, 1, `more than one line: ${r.out}`);
}

test("threads verbs: start with a purpose, one-shot get, interrupt, mode, queue verbs and rewind, or what is coming", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const s = await vyre(["threads", "start", "--cwd", w.work, "--purpose", "chat", "--json", "hello from alex"], w.env);
  assert.equal(s.code, 0, s.out);
  const id = JSON.parse(s.stdout).id;
  await until(async () => ((await w.tool("threads.get", { thread: id })).data?.events || []).some(e => e.type === "thread.finished"), "the first turn");

  // One read, then back to the prompt.
  const g = await vyre(["threads", "get", id.slice(0, 8)], w.env);
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /echo: hello from alex/);
  assert.match(g.out, /vyre threads watch \w{8} follows it · --since \d+/);
  const gj = JSON.parse((await vyre(["threads", "show", id, "--limit", "2", "--json"], w.env)).stdout);
  assert.equal(gj.thread.id, id);
  assert.ok(gj.events.length <= 2);
  const last = gj.events.at(-1).id;
  assert.deepEqual(JSON.parse((await vyre(["threads", "get", id, "--since", String(last), "--json"], w.env)).stdout).events, []);
  assert.equal((await vyre(["threads", "get", id, "--limit", "lots"], w.env)).code, 2);

  // Sends: --queue and --steer are accepted either way; a vyred that has no modes yet just sends.
  const q = await vyre(["threads", "send", id, "--queue", "and", "the", "hours"], w.env);
  assert.equal(q.code, 0, q.out);
  assert.match(q.out, /queued|sent/);
  assert.equal((await vyre(["threads", "send", id, "--queue", "--steer", "x"], w.env)).code, 2);
  await until(async () => ((await w.tool("threads.get", { thread: id })).data?.events || []).filter(e => e.type === "thread.finished").length >= 2, "the second turn");

  // interrupt: an idle session has no turn to stop, and says so.
  const i = await vyre(["threads", "interrupt", id], w.env);
  if (w.have.has("threads.interrupt")) { assert.equal(i.code, 0, i.out); assert.match(i.out, /interrupted|not running|nothing to interrupt/); }
  else coming(i, "threads.interrupt");

  // mode: set, then read back.
  const m = await vyre(["threads", "mode", id, "plan"], w.env);
  if (w.have.has("threads.mode")) {
    assert.equal(m.code, 0, m.out);
    assert.match(m.out, /mode: plan/);
    assert.match((await vyre(["threads", "mode", id], w.env)).out, /mode: plan/);
    assert.equal(JSON.parse((await vyre(["threads", "mode", id, "--json"], w.env)).stdout).mode, "plan");
  } else coming(m, "threads.mode");
  assert.equal((await vyre(["threads", "mode", id, "bypassPermissions"], w.env)).code, 2, "bypassPermissions is never offered");

  // queue: read from the thread's events; nothing is held for a session vyred runs between turns.
  const ql = await vyre(["threads", "queue", id], w.env);
  assert.equal(ql.code, 0, ql.out);
  assert.match(ql.out, /nothing is queued|from the thread's last 1000 events/);
  assert.ok(Array.isArray(JSON.parse((await vyre(["threads", "queue", id, "--json"], w.env)).stdout)));

  for (const [verb, name, extra] of [["take-back", "threads.unqueue", []], ["send-now", "threads.send-now", []], ["fork", "threads.fork", []], ["edit", "threads.edit", ["the", "fax"]], ["rewind", "threads.rewind", []]]) {
    const r = await vyre(["threads", verb, id, verb === "rewind" ? "00000000-0000-4000-8000-000000000000" : "999999", ...extra], w.env);
    if (w.have.has(name)) assert.notEqual(r.code, 2, r.out);
    else coming(r, name);
  }
  assert.equal((await vyre(["threads", "take-back", id], w.env)).code, 2, "take-back needs the queued id");
});

test("threads chat parity: model, thinking, commands, shell and !, remember and #, tasks, images, rewind list, or what is coming", { timeout: 120_000 }, async t => {
  const w = await world(t);
  // Main has had these since batch 3b: the live path runs, never only the "coming" line.
  for (const name of PARITY) assert.ok(w.have.has(name), `${name} is on this vyred`);
  const s = await vyre(["threads", "start", "--cwd", w.work, "--json", "hello from alex"], w.env);
  assert.equal(s.code, 0, s.out);
  const id = JSON.parse(s.stdout).id;
  const events = async () => (await w.tool("threads.get", { thread: id, limit: 1000 })).data?.events || [];
  const finished = async n => until(async () => (await events()).filter(e => e.type === "thread.finished").length >= n, `turn ${n}`);
  await finished(1);
  let turns = 1;

  // model: read from the record on any vyred; switched where vyred can.
  const m0 = await vyre(["threads", "model", id], w.env);
  assert.equal(m0.code, 0, m0.out);
  assert.match(m0.out, /model: /);
  assert.ok("model" in JSON.parse((await vyre(["threads", "model", id, "--json"], w.env)).stdout));
  assert.equal((await vyre(["threads", "model", id, "not a model!"], w.env)).code, 2);
  const m = await vyre(["threads", "model", id, "haiku"], w.env);
  if (w.have.has("threads.model")) {
    assert.equal(m.code, 0, m.out);
    assert.match(m.out, /model: haiku/);
    assert.equal(JSON.parse((await vyre(["threads", "model", id, "--json"], w.env)).stdout).model, "haiku");
    assert.match((await vyre(["threads", "get", id], w.env)).out, /^ +model: haiku/m, "the switch shows in the thread");
  } else coming(m, "threads.model");

  // thinking: on for a live session, or a clear "not running".
  assert.equal((await vyre(["threads", "thinking", id, "maybe"], w.env)).code, 2);
  const th = await vyre(["threads", "thinking", id, "on"], w.env);
  if (w.have.has("threads.thinking")) assert.match(th.out, th.code === 0 ? /thinking: on/ : /not running/, th.out);
  else coming(th, "threads.thinking");

  const c = await vyre(["threads", "commands", id], w.env);
  if (w.have.has("threads.commands")) {
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /\/compact|not running/);
    assert.ok(Array.isArray(JSON.parse((await vyre(["threads", "commands", id, "--json"], w.env)).stdout).commands));
  } else coming(c, "threads.commands");

  // ! mode, by verb and by the composer's shortcut; --raw sends it as words.
  const sh = await vyre(["threads", "shell", id, "echo", "northwind", "--bakery"], w.env);
  const bang = await vyre(["threads", "send", id, "!echo harlow"], w.env);
  if (w.have.has("threads.shell")) {
    assert.equal(sh.code, 0, sh.out);
    assert.match(sh.stdout, /^northwind --bakery$/m);
    assert.equal(bang.code, 0, bang.out);
    assert.match(bang.stdout, /^harlow$/m);
    assert.equal((await vyre(["threads", "shell", id, "exit 3"], w.env)).code, 1);
    assert.equal(JSON.parse((await vyre(["threads", "shell", id, "--json", "echo", "hi"], w.env)).stdout).output.trim(), "hi");
  } else { coming(sh, "threads.shell"); coming(bang, "threads.shell"); }
  assert.equal((await vyre(["threads", "shell", id], w.env)).code, 2);
  assert.equal((await vyre(["threads", "send", id, "!"], w.env)).code, 2);
  assert.equal((await vyre(["threads", "send", id, "--queue", "!ls"], w.env)).code, 2);

  // /remember: the project's CLAUDE.md in the thread's folder, or the folder's private one. Never user.
  const r1 = await vyre(["threads", "remember", id, "prefer", "tabs"], w.env);
  const r2 = await vyre(["threads", "send", id, "/remember prices in dollars"], w.env);
  const r3 = await vyre(["threads", "remember", id, "--scope", "local", "juno", "reviews", "drafts"], w.env);
  if (w.have.has("threads.remember")) {
    for (const r of [r1, r2, r3]) assert.equal(r.code, 0, r.out);
    assert.match(r1.out, /remembered in .*CLAUDE\.md \(project\)/);
    assert.equal(fs.readFileSync(path.join(w.work, "CLAUDE.md"), "utf8"), "- prefer tabs\n- prices in dollars\n");
    assert.equal(fs.readFileSync(path.join(w.work, "CLAUDE.local.md"), "utf8"), "- juno reviews drafts\n");
  } else { coming(r1, "threads.remember"); coming(r2, "threads.remember"); coming(r3, "threads.remember"); }
  assert.equal((await vyre(["threads", "remember", id, "--scope", "team", "x"], w.env)).code, 2);

  // Images: checked here first, then sent where vyred takes them.
  const png = path.join(w.work, "menu.png");
  fs.writeFileSync(png, PNG);
  fs.writeFileSync(path.join(w.work, "menu.txt"), "hi");
  assert.equal((await vyre(["threads", "send", id, "--image", path.join(w.work, "menu.txt"), "look"], w.env)).code, 2);
  assert.equal((await vyre(["threads", "send", id, ...Array(6).fill(["--image", png]).flat(), "look"], w.env)).code, 2);
  assert.equal((await vyre(["threads", "send", id, "--image"], w.env)).code, 2);
  const img = await vyre(["threads", "send", id, "--image", png, "what", "is", "on", "this", "menu"], w.env);
  if (w.have.has("threads.send") && (await request("GET", "/v1/tools", null, { root: w.root })).data.find(x => x.name === "threads.send").input.properties.images) {
    assert.equal(img.code, 0, img.out);
    await finished(++turns);
    assert.match((await vyre(["threads", "get", id], w.env)).out, /what is on this menu \(\+1 image\)/);
    // An image alone is a message too.
    assert.equal((await vyre(["threads", "send", id, "--image", png], w.env)).code, 0);
    await finished(++turns);
  } else coming(img, "threads.send with images");

  // --raw: the ! is words, sent as a message on any vyred.
  const raw = await vyre(["threads", "send", id, "--raw", "!not a shell line"], w.env);
  assert.equal(raw.code, 0, raw.out);
  await finished(++turns);
  assert.ok((await events()).some(e => e.type === "thread.sent" && e.payload.text === "!not a shell line"));

  // Background tasks: started by a turn, listed, stopped.
  const tl = await vyre(["threads", "tasks", id], w.env);
  if (w.have.has("threads.tasks")) {
    assert.equal(tl.code, 0, tl.out);
    assert.match(tl.out, /no background tasks/);
    assert.equal((await vyre(["threads", "send", id, "background sleep 30"], w.env)).code, 0);
    await finished(++turns);
    const task = await until(async () => (await events()).find(e => e.type === "thread.task")?.payload.id, "a background task");
    assert.match((await vyre(["threads", "tasks", id], w.env)).out, new RegExp(`${task} +running +shell +sleep 30`));
    const k = await vyre(["threads", "kill-task", id, task], w.env);
    assert.equal(k.code, 0, k.out);
    assert.match(k.out, new RegExp(`stopped task ${task}`));
    await until(async () => JSON.parse((await vyre(["threads", "tasks", id, "--json"], w.env)).stdout).tasks.some(x => x.id === task && x.status === "killed"), "the task killed");
    assert.match((await vyre(["threads", "get", id], w.env)).out, new RegExp(`shell task ${task} killed`));
  } else {
    coming(tl, "threads.tasks");
    coming(await vyre(["threads", "kill-task", id, "task_1"], w.env), "threads.kill-task");
  }
  assert.equal((await vyre(["threads", "kill-task", id], w.env)).code, 2);

  // rewind with no message: the list, numbered (no terminal here, so no question).
  const rl = await vyre(["threads", "rewind", id], w.env);
  assert.equal(rl.code, 0, rl.out);
  assert.match(rl.out, /^ +1 +\w{8} +hello from alex$/m);
  assert.match(rl.out, /vyre threads rewind \w{8} <n>/);
  const listed = JSON.parse((await vyre(["threads", "rewind", id, "--json"], w.env)).stdout);
  assert.equal(listed[0].n, 1);
  assert.equal(listed[0].text, "hello from alex");
  assert.equal((await vyre(["threads", "rewind", id, "99"], w.env)).code, 2);
  assert.equal((await vyre(["threads", "rewind", id, "1", "--restore", "all"], w.env)).code, 2);
  const rc = await vyre(["threads", "rewind", id, "1", "--restore", "code"], w.env);
  if (w.have.has("threads.rewind") && (await request("GET", "/v1/tools", null, { root: w.root })).data.find(x => x.name === "threads.rewind").input.properties.restore) assert.notEqual(rc.code, 2, rc.out);
  else coming(rc, "threads.rewind --restore");
});

test("threads open: vyred lets go of an idle session and claude --resume runs here", { timeout: 60_000 }, async t => {
  const w = await world(t);
  const started = await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" });
  assert.ok(started.data, JSON.stringify(started));
  const id = started.data.id;
  await until(async () => (await w.tool("threads.get", { thread: id })).data?.thread.status === "idle", "an idle session");
  // A stand-in claude on PATH that says how it was run.
  const bin = fs.mkdtempSync(path.join(SCRATCH, "vyre-bin-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const said = path.join(bin, "argv");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" > "${said}"\n`, { mode: 0o755 });
  const r = await vyre(["threads", "open", id.slice(0, 8)], { ...w.env, PATH: `${bin}:${process.env.PATH}`, VYRE_HARNESS_DIR: path.join(bin, "none") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /handed over from vyred/);
  assert.match(fs.readFileSync(said, "utf8"), new RegExp(`--resume ${id}`));
  assert.equal((await w.tool("threads.get", { thread: id })).data.thread.status, "stopped");
});

test("threads watch: a vyred restart mid-watch reconnects from the last event and repeats nothing", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const started = await w.tool("threads.start", { cwd: w.work, prompt: "first words", surface: "deck" });
  const id = started.data.id;
  await until(async () => (await w.tool("threads.get", { thread: id })).data?.thread.status === "idle", "the first turn");
  const p = spawn(process.execPath, [BIN, "threads", "watch", id], { env: { ...process.env, ...w.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", c => (out += c)); p.stderr.on("data", c => (out += c));
  const closed = new Promise(r => p.on("close", r));
  t.after(async () => { if (p.exitCode === null) { p.kill("SIGINT"); await closed; } });
  await until(() => /echo: first words/.test(out), "the history");

  await w.box.d.stop();
  await until(() => /reconnecting to vyred/.test(out), "the reconnecting line");
  w.box.d = await w.boot();
  await until(() => /^ +back$/m.test(out), "the stream again");
  // deck took the keyboard at start; the next words come from there too.
  const sent = await w.tool("threads.send", { thread: id, text: "second words", surface: "deck" });
  assert.ok(sent.data, JSON.stringify(sent));
  await until(() => /echo: second words/.test(out), "the reply after the restart");
  p.kill("SIGINT");
  await closed;
  assert.equal(out.match(/echo: first words/g)?.length, 1, `the first reply was printed again:\n${out}`);
  assert.equal(out.match(/echo: second words/g)?.length, 1, out);
});

test("vyre sessions: status, models, prompt set, history, revert and preview, or what is coming", { timeout: 60_000 }, async t => {
  const w = await world(t);
  const st = await vyre(["sessions"], w.env);
  if (!w.have.has("sessions.status")) {
    coming(st, "sessions.status");
    coming(await vyre(["sessions", "models"], w.env), "sessions.models.get");
    coming(await vyre(["sessions", "prompt"], w.env), "sessions.prompt.get");
    coming(await vyre(["sessions", "models", "chat", "haiku"], w.env), "sessions.models.set");
    coming(await vyre(["sessions", "prompt", "set", "--text", "Answer alex briefly."], w.env), "sessions.prompt.set");
    assert.equal((await vyre(["sessions", "bogus"], w.env)).code, 2);
    return;
  }
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /driver \w+ +sign-in/);
  assert.match(st.out, /Agent SDK/);
  assert.ok(JSON.parse((await vyre(["sessions", "--json"], w.env)).stdout).driver);

  // Models: a purpose and a project, set and cleared.
  const set = await vyre(["sessions", "models", "job", "haiku"], w.env);
  assert.equal(set.code, 0, set.out);
  assert.match(set.out, /purpose:job runs on haiku/);
  assert.match((await vyre(["sessions", "models", "job"], w.env)).out, /purpose:job +haiku +from purpose:job/);
  assert.equal((await vyre(["sessions", "models", "northwind-bakery", "sonnet"], w.env)).code, 0);
  const all = JSON.parse((await vyre(["sessions", "models", "--json"], w.env)).stdout);
  assert.equal(all.purposes.job.model, "haiku");
  assert.equal(all.projects["northwind-bakery"], "sonnet");
  assert.match((await vyre(["sessions", "models"], w.env)).out, /by project[\s\S]*northwind-bakery +sonnet/);
  assert.match((await vyre(["sessions", "models", "job", "--clear"], w.env)).out, /back to its default/);
  assert.notEqual(JSON.parse((await vyre(["sessions", "models", "--json"], w.env)).stdout).purposes.job.from, "purpose:job");
  assert.equal((await vyre(["sessions", "models", "job", "haiku", "--clear"], w.env)).code, 2);

  // Prompts: a version per edit, $EDITOR, history, revert, preview.
  assert.match((await vyre(["sessions", "prompt"], w.env)).out, /assistant adds nothing/);
  const p1 = await vyre(["sessions", "prompt", "set", "--text", "Answer alex in short paragraphs."], w.env);
  assert.equal(p1.code, 0, p1.out);
  assert.match(p1.out, /saved assistant v1/);
  const editor = path.join(w.work, "editor.sh");
  fs.writeFileSync(editor, `#!/bin/sh\ngrep -q "short paragraphs" "$1" || exit 3\nprintf 'Answer alex in one paragraph.\\n' > "$1"\n`, { mode: 0o755 });
  const p2 = await vyre(["sessions", "prompt", "assistant", "set"], { ...w.env, EDITOR: editor, VISUAL: "" });
  assert.equal(p2.code, 0, p2.out);
  assert.match(p2.out, /saved assistant v2/);
  assert.match((await vyre(["sessions", "prompt", "assistant", "show"], w.env)).out, /v2[\s\S]*Answer alex in one paragraph\./);
  assert.match((await vyre(["sessions", "prompt", "set"], { ...w.env, EDITOR: "true", VISUAL: "" })).out, /nothing changed/);
  const h = await vyre(["sessions", "prompt", "history"], w.env);
  assert.match(h.out, /v2[\s\S]*one paragraph[\s\S]*v1[\s\S]*short paragraphs/);
  const rv = await vyre(["sessions", "prompt", "revert", "1"], w.env);
  assert.equal(rv.code, 0, rv.out);
  assert.match(rv.out, /reverted assistant to v1.*as v3/);
  assert.equal(JSON.parse((await vyre(["sessions", "prompt", "--json"], w.env)).stdout).prompt.text, "Answer alex in short paragraphs.");
  const pr = await vyre(["sessions", "prompt", "project:northwind-bakery", "set", "--text", "Prices are in dollars with two decimals.", "--replace"], w.env);
  assert.equal(pr.code, 0, pr.out);
  assert.match(pr.out, /for experts/);
  const pv = await vyre(["sessions", "prompt", "project:northwind-bakery", "preview"], w.env);
  assert.equal(pv.code, 0, pv.out);
  assert.match(pv.out, /Prices are in dollars/);
  assert.equal((await vyre(["sessions", "prompt", "revert", "x"], w.env)).code, 2);
  assert.equal((await vyre(["sessions", "prompt", "history", "--text", "x"], w.env)).code, 2);
});
