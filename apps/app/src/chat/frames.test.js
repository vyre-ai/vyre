// @ts-check
// Row folding: frames in, rows and items out; dedupe by cursor; queued messages; asks; resets.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFolder, headerState, busyState } from "./frames.js";

let cur = 0;
/** @param {string} type @param {any} data */
const fr = (type, data) => ({ v: 1, id: "x" + cur, cur: ++cur, session: "s", turn: "t", type: "session." + type, time: 0, corr: "t", data });

test("text deltas fold into one row and grow it", () => {
  cur = 0;
  const f = createFolder();
  const a = f.apply(fr("text-delta", { message: "a1", index: 0, text: "Hel" }));
  assert.equal(a.layout, true);
  assert.deepEqual(a.appended, { key: "a:a1", length: 3 });
  const b = f.apply(fr("text-delta", { message: "a1", index: 1, text: "lo" }));
  assert.equal(b.layout, false, "a delta on a known row is not a layout change");
  assert.equal(f.item("a:a1")?.text, "Hello");
  f.apply(fr("text-done", { message: "a1" }));
  assert.equal(f.item("a:a1")?.done, true);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rev("a:a1"), 3);
});

test("frames at or below the cursor are dropped, a gap is flagged", () => {
  cur = 0;
  const f = createFolder();
  const one = fr("text-delta", { message: "a", index: 0, text: "x" });
  f.apply(one);
  assert.equal(f.apply(one).dup, true);
  assert.equal(f.item("a:a")?.text, "x");
  const skip = { ...fr("text-delta", { message: "a", index: 1, text: "y" }), cur: 5 };
  assert.equal(f.apply(skip).gap, true);
  assert.equal(f.last, 5);
});

test("a tool runs, streams output and finishes with a block", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("tool-started", { tool_id: "t1", tool: "Bash", kind: "terminal", summary: "ls" }));
  f.apply(fr("tool-progress", { tool_id: "t1", text: "a\n" }));
  f.apply(fr("tool-progress", { tool_id: "t1", text: "b\n" }));
  assert.equal(f.item("t:t1")?.output, "a\nb\n");
  assert.equal(f.item("t:t1")?.status, "running");
  f.apply(fr("tool-finished", { tool_id: "t1", ok: false, result: { block: "terminal", output: "a\nb\n", exit: 1 } }));
  assert.equal(f.item("t:t1")?.status, "failed");
  assert.equal(f.item("t:t1")?.block.block, "terminal");
});

test("a queued message sits in the queue, not the transcript, until picked up", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("status", { state: "working" }));
  f.apply(fr("user-message", { message: "m2", text: "also this", state: "queued" }));
  assert.equal(f.queue().length, 1);
  assert.equal(f.rows.length, 0);
  const r = f.apply(fr("user-message", { message: "m2", text: "also this", state: "picked-up" }));
  assert.equal(r.layout, true);
  assert.equal(f.queue().length, 0);
  assert.equal(f.item("u:m2")?.pickedUp, true);
  assert.equal(f.rows[0].key, "u:m2");
});

test("an ask opens, then is answered", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("ask", { ask_id: "k1", kind: "approval", task: { block: "task", title: "Send" } }));
  assert.equal(f.item("k:k1")?.state, "open");
  f.apply(fr("ask-answered", { ask_id: "k1", decision: "approve" }));
  assert.equal(f.item("k:k1")?.state, "answered");
  assert.equal(f.item("k:k1")?.decision, "approve");
});

test("status sets the header state and leaves a line only for the ones that end or pause", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("status", { state: "working", turn: "t1" }));
  assert.equal(f.rows.length, 0);
  assert.equal(f.status.state, "working");
  f.apply(fr("status", { state: "paused" }));
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].kind, "notice");
});

test("a failed status that says it could not resume shows \"Couldn't resume. Ask again.\"; an unknown note changes nothing", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("status", { state: "failed", note: "couldn't resume, ask again" }));
  assert.equal(f.item(f.rows[0].key)?.text, "Couldn't resume. Ask again.");
  f.apply(fr("status", { state: "failed", note: "something else" }));
  assert.equal(f.item(f.rows[1].key)?.text, "This chat failed.");
});

test("a reset clears the rows and takes its cursor", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("text-delta", { message: "a", index: 0, text: "x" }));
  const r = f.apply(fr("reset", { reason: "old" }));
  assert.equal(r.reset, true);
  assert.equal(f.rows.length, 0);
  assert.equal(f.last, cur);
});

test("term chunks decode into a terminal row", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("term-chunk", { term: "1", offset: 0, b64: Buffer.from("hi\n").toString("base64") }));
  f.apply(fr("term-chunk", { term: "1", offset: 3, b64: Buffer.from("there\n").toString("base64") }));
  assert.equal(f.item("x:1")?.output, "hi\nthere\n");
});

test("the rows array is replaced only when a row is added", () => {
  cur = 0;
  const f = createFolder();
  f.apply(fr("text-delta", { message: "a", index: 0, text: "x" }));
  const r1 = f.rows;
  f.apply(fr("text-delta", { message: "a", index: 1, text: "y" }));
  assert.equal(f.rows, r1);
  f.apply(fr("text-delta", { message: "b", index: 0, text: "z" }));
  assert.notEqual(f.rows, r1);
});

test("headerState: busy shows Stop, stopping does not", () => {
  assert.deepEqual(headerState({ state: "working" }), { word: "working", busy: true, canStop: true });
  assert.equal(headerState({ state: "working", stopping: true }).word, "stopping");
  assert.equal(headerState({ state: "asking" }).word, "needs you");
  assert.equal(headerState({ state: "waiting" }).canStop, false);
  assert.equal(busyState("paused"), false);
});

test("a long history folds fast", () => {
  cur = 0;
  const f = createFolder();
  const frames = [];
  for (let i = 0; i < 20000; i++) frames.push(fr("text-delta", { message: "m" + i, index: 0, text: "hello" }));
  const t = Date.now();
  const r = f.applyAll(frames);
  assert.equal(f.rows.length, 20000);
  assert.equal(r.layout, true);
  assert.ok(Date.now() - t < 2000);
});

test("a queued message taken back leaves the queue and draws no row", () => {
  const f = createFolder();
  f.apply(fr("user-message", { message: "m9", text: "never mind", state: "queued" }));
  assert.equal(f.queue().length, 1);
  f.apply(fr("user-message", { message: "m9", text: "", state: "cancelled" }));
  assert.equal(f.queue().length, 0);
  assert.equal(f.rows.some((r) => r.key === "u:m9"), false);
});

// ---- group chats (task G) ----

import { HOLDBACK } from "./frames.js";
import { HOLDBACK as CORE_HOLDBACK } from "../../../../core/stream/frame.js";

/** @param {string} type @param {any} data @param {any} [extra] */
const gf = (type, data, extra = {}) => ({ ...fr(type, data), ...extra });

test("holdback matches core/stream", () => assert.equal(HOLDBACK, CORE_HOLDBACK));

test("two assistants streaming at once keep their own rows, authors and acts_for; text never mixes", () => {
  cur = 0;
  const f = createFolder();
  const kit = { author: "assistant:kit", acts_for: "person:chris", message: "m1" };
  const juno = { author: "assistant:juno", acts_for: "person:alex", message: "m2" };
  f.apply(gf("text-delta", { message: "m1", index: 0, text: "one " }, kit));
  f.apply(gf("text-delta", { message: "m2", index: 0, text: "two " }, juno));
  f.apply(gf("text-delta", { message: "m1", index: 0, text: "more" }, kit));
  f.apply(gf("text-delta", { message: "m2", index: 0, text: "more", parent: "q" }, juno));
  assert.equal(f.item("a:m1")?.text, "one more");
  assert.equal(f.item("a:m2")?.text, "two more");
  assert.equal(f.item("a:m1")?.author, "assistant:kit");
  assert.equal(f.item("a:m1")?.actsFor, "person:chris");
  assert.equal(f.item("a:m2")?.actsFor, "person:alex");
  assert.equal(f.rows.length, 2);
  f.apply(gf("text-done", { message: "m1" }, kit));
  assert.equal(f.item("a:m1")?.done, true);
  assert.equal(f.item("a:m2")?.done, false);
  f.apply(gf("text-delta", { message: "m1", index: 0, text: "late" }, kit));
  assert.equal(f.item("a:m1")?.text, "one more", "a finished message takes no more text");
});

test("random interleavings of three streams fold to each message's exact text (seeded x200)", () => {
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let it = 0; it < 200; it++) {
    cur = 0;
    const f = createFolder();
    const m = ["m1", "m2", "m3"].map(id => ({ id, left: 5 + Math.floor(rnd() * 20), text: "" }));
    while (m.some(x => x.left > 0)) {
      const live = m.filter(x => x.left > 0);
      const x = live[Math.floor(rnd() * live.length)];
      const w = "w" + Math.floor(rnd() * 100) + " ";
      x.text += w; x.left--;
      f.apply(gf("text-delta", { message: x.id, index: 0, text: w }, { author: "assistant:" + x.id, message: x.id }));
    }
    for (const x of m) assert.equal(f.item("a:" + x.id)?.text, x.text);
  }
});

test("the last 40 characters of a streaming reply are provisional until text-done", () => {
  cur = 0;
  const f = createFolder();
  f.apply(gf("text-delta", { message: "a", index: 0, text: "x".repeat(100) }));
  assert.equal(f.item("a:a")?.settled, 60);
  f.apply(gf("text-delta", { message: "a", index: 0, text: "y".repeat(10) }));
  assert.equal(f.item("a:a")?.settled, 70);
  f.apply(gf("text-done", { message: "a" }));
  assert.equal(f.item("a:a")?.settled, 110);
});

test("text-cut drops the provisional tail and leaves the note", () => {
  cur = 0;
  const f = createFolder();
  f.apply(gf("text-delta", { message: "a", index: 0, text: "Your number is " + "1".repeat(60) }));
  const before = f.item("a:a")?.text.length;
  f.apply(gf("text-cut", { message: "a", note: "stopped: a sealed value was about to be shown" }));
  const it = f.item("a:a");
  assert.equal(it?.text.length, (before ?? 0) - HOLDBACK);
  assert.equal(it?.done, true);
  assert.equal(it?.cut, "stopped: a sealed value was about to be shown");
  assert.equal(it?.settled, it?.text.length);
});

test("participants, presence, reactions, pins, mentions, thread replies, read marker", () => {
  cur = 0;
  const f = createFolder();
  f.apply(gf("participant-joined", { who: "assistant:kit" }));
  f.apply(gf("participant-joined", { who: "person:chris" }));
  f.apply(gf("participant-left", { who: "person:chris" }));
  assert.deepEqual(f.participants(), ["assistant:kit"]);
  f.apply(gf("user-message", { message: "u1", text: "hi @kit", state: "sent" }, { author: "person:alex" }));
  f.apply(gf("user-message", { message: "u2", text: "re", state: "sent", parent: "u1" }, { author: "person:chris" }));
  assert.equal(f.item("u:u2")?.parent, "u1");
  f.apply(gf("mention", { message: "u1", who: ["assistant:kit"] }));
  assert.deepEqual(f.mentioned("u1"), ["assistant:kit"]);
  f.apply(gf("reaction", { message: "u1", emoji: "👍", on: true }, { author: "person:chris" }));
  f.apply(gf("reaction", { message: "u1", emoji: "👍", on: true }, { author: "person:alex" }));
  f.apply(gf("reaction", { message: "u1", emoji: "👍", on: false }, { author: "person:chris" }));
  assert.deepEqual(f.reactions("u1"), [{ emoji: "👍", who: ["person:alex"] }]);
  f.apply(gf("pin", { message: "u1", on: true }));
  assert.deepEqual(f.pinned(), ["u1"]);
  const last = f.last;
  f.apply({ v: 1, id: "p", cur: 0, session: "s", turn: null, type: "session.presence", time: 5, corr: null, data: { who: "assistant:kit", state: "doing", doing: "running the tests" } });
  assert.deepEqual(f.presence(), [{ who: "assistant:kit", state: "doing", doing: "running the tests", at: 5 }]);
  f.apply({ v: 1, id: "r", cur: 0, session: "s", turn: null, type: "session.read-marker", time: 5, corr: null, data: { upto: 9 } });
  f.apply({ v: 1, id: "r", cur: 0, session: "s", turn: null, type: "session.read-marker", time: 5, corr: null, data: { upto: 4 } });
  assert.equal(f.readUpto, 9);
  assert.equal(f.last, last, "ephemeral frames never move the cursor");
});

test("fanout: the answers are one group until one is kept", () => {
  cur = 0;
  const f = createFolder();
  f.apply(gf("user-message", { message: "q", text: "which?", state: "sent" }, { author: "person:alex" }));
  f.apply(gf("text-delta", { message: "a1", index: 0, text: "A" }, { author: "model:one", message: "a1" }));
  f.apply(gf("fanout", { group: "g", message: "q", members: [{ who: "model:one", message: "a1" }, { who: "model:two", message: "a2" }] }));
  f.apply(gf("text-delta", { message: "a2", index: 0, text: "B" }, { author: "model:two", message: "a2" }));
  assert.equal(f.item("a:a1")?.group, "g", "an answer that arrived first joins the group");
  assert.equal(f.item("a:a2")?.group, "g");
  assert.equal(f.group("g")?.keep, null);
  f.apply(gf("fanout-keep", { group: "g", keep: "nope" }));
  assert.equal(f.group("g")?.keep, null, "keep must be a member");
  f.apply(gf("fanout-keep", { group: "g", keep: "a2" }));
  assert.equal(f.group("g")?.keep, "a2");
  assert.equal(f.group("g")?.members.length, 2);
});

test("join notices carry display names, never the raw id", () => {
  cur = 0;
  const f = createFolder();
  f.apply(gf("participant-joined", { who: "person:alex", name: "Alex Rivera" }));
  f.apply(gf("participant-joined", { who: "assistant:kit-2" }));
  f.apply(gf("participant-left", { who: "person:alex" }));
  const texts = f.rows.filter((r) => r.kind === "notice").map((r) => f.item(r.key)?.text);
  assert.deepEqual(texts, ["Alex Rivera joined", "Kit 2 joined", "Alex Rivera left"]);
  assert.ok(!texts.join(" ").includes("person:"));
  assert.equal(f.name("assistant:juno"), "Juno");
});

test("a group chat has no status frames: it is working while any reply is open, ready otherwise", () => {
  cur = 0;
  const f = createFolder();
  assert.equal(f.status.state, "starting");
  f.apply(gf("participant-joined", { who: "assistant:kit" }));
  assert.equal(f.status.state, "waiting", "joined, nothing said: ready, not working");
  f.apply(gf("text-delta", { message: "a1", index: 0, text: "A" }, { author: "assistant:kit", message: "a1" }));
  f.apply(gf("text-delta", { message: "a2", index: 0, text: "B" }, { author: "assistant:juno", message: "a2" }));
  assert.equal(f.status.state, "working");
  f.apply(gf("text-done", { message: "a1" }, { author: "assistant:kit", message: "a1" }));
  assert.equal(f.status.state, "working", "juno is still answering");
  f.apply(gf("text-cut", { message: "a2", note: "x" }, { author: "assistant:juno", message: "a2" }));
  assert.equal(f.status.state, "waiting");
  // A thread's own status frames still win.
  f.apply(gf("status", { state: "asking", turn: "t" }));
  f.apply(gf("text-done", { message: "zz" }));
  assert.equal(f.status.state, "asking");
});

test("frames: a private message (enc) is a row that says Private message, never its ciphertext", () => {
  cur = 0;
  const f = createFolder();
  const fp = fr("user-message", { message: "p1", enc: { alg: "mls-x", kid: "dev:a#1", ct: "SECRETCT" }, state: "sent" });
  f.apply(fp);
  assert.equal(f.item("u:p1")?.text, "Private message");
  assert.equal(f.item("u:p1")?.private, true);
  assert.ok(!JSON.stringify(f.item("u:p1")).includes("SECRETCT"));
});

test("a person who joined late sees the chat from their join: placeholders hold the cursor, who was there is roster only, their join is the one marker", () => {
  cur = 0;
  const f = createFolder();
  const hid = (/** @type {number} */ cu, /** @type {number} */ span) => ({ v: 1, id: "h" + cu, cur: cu, ...(span > 1 ? { span } : {}), session: "s", turn: null, type: "session.hidden", time: 0, corr: null, data: {} });
  // what the server sends a viewer whose join is at cursor 8: the earlier messages as one placeholder run, earlier joins as quiet roster frames
  const joined = (/** @type {number} */ cu, /** @type {string} */ who, /** @type {any} */ extra = {}) => ({ v: 1, id: "j" + cu, cur: cu, session: "s", turn: null, type: "session.participant-joined", time: 0, corr: null, data: { who, name: who.split(":")[1], ...extra } });
  assert.equal(f.apply(joined(1, "person:alex", { quiet: true })).gap, false);
  assert.equal(f.apply(joined(2, "assistant:kit", { quiet: true })).gap, false);
  assert.equal(f.apply(hid(7, 5)).gap, false, "one placeholder covers cursors 3 to 7, so the cursor stays gapless");
  f.apply(joined(8, "person:chris"));
  assert.deepEqual(f.participants(), ["person:alex", "assistant:kit", "person:chris"], "the roster is whole");
  assert.deepEqual(f.rows.map((r) => f.item(r.key)?.text), ["chris joined"], "one quiet line, nothing above it");
  // a reply that streamed while they joined arrives as placeholders only, and the next message is whole
  f.apply(hid(9, 1)); f.apply(hid(10, 1));
  f.apply({ v: 1, id: "u", cur: 11, session: "s", turn: null, type: "session.user-message", time: 0, corr: null, author: "person:alex", data: { message: "u2", text: "and now?", state: "sent" } });
  assert.deepEqual(f.rows.map((r) => f.item(r.key)?.text), ["chris joined", "and now?"]);
  assert.equal(f.last, 11);
});

test("a message the person's assistant sent for them keeps via, so it can be marked", () => {
  cur = 0;
  const f = createFolder();
  f.apply({ ...fr("user-message", { message: "s1", text: "run the tests", state: "sent" }), author: "person:alex", via: "assistant" });
  assert.equal(f.item(f.rows[0].key)?.via, "assistant");
  f.apply({ ...fr("user-message", { message: "s2", text: "thanks", state: "sent" }), author: "person:alex" });
  assert.equal(f.item(f.rows[1].key)?.via, undefined);
});

test("a join with no name whose id is a person's or a model slot's id makes no line", () => {
  cur = 0;
  const f = createFolder();
  f.apply(gf("participant-joined", { who: "person:per_i44k7pe25e3f3xrmtetxjgmixa" }));
  f.apply(gf("participant-joined", { who: "model:claude/default#694682" }));
  assert.equal(f.rows.filter((r) => r.kind === "notice").length, 0);
});

test("optimistic send: the words show at once, dimmed, and the box's own row replaces them; a failed send takes them back", () => {
  cur = 0;
  const f = createFolder();
  const key = f.addOptimistic("Chase the invoices");
  assert.deepEqual(f.rows.map((r) => r.key), [key]);
  assert.equal(f.item(key)?.pending, true);
  assert.equal(f.item(key)?.text, "Chase the invoices");
  // the echo (the same words, with spaces around them) takes the placeholder's place: one row, not two
  const echo = f.apply(fr("user-message", { message: "u1", text: "  Chase the invoices ", state: "picked-up" }));
  assert.equal(echo.layout, true);
  assert.deepEqual(f.rows.map((r) => r.key), ["u:u1"]);
  assert.equal(f.item(key), null, "the placeholder is gone");
  assert.equal(f.item("u:u1")?.pending, undefined);
  // two in flight settle in the order sent, by their words
  const a = f.addOptimistic("one"), b = f.addOptimistic("two");
  f.apply(fr("user-message", { message: "u3", text: "two", state: "picked-up" }));
  assert.deepEqual(f.rows.map((r) => r.key), ["u:u1", a, "u:u3"]);
  assert.equal(f.dropOptimistic(a), true, "a refused send takes its words back");
  assert.equal(f.dropOptimistic(a), false);
  assert.deepEqual(f.rows.map((r) => r.key), ["u:u1", "u:u3"]);
  // a queued echo (the assistant is busy) also settles it: the queue line shows it from here
  const c = f.addOptimistic("later");
  f.apply(fr("user-message", { message: "u4", text: "later", state: "queued" }));
  assert.equal(f.item(c), null);
  assert.equal(f.queue().length, 1);
  void b;
});
