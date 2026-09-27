// @ts-check
// The session view in the fake DOM (deck/test/fake-dom.js) with a fake vyred behind fetch and a
// fake event stream: blocks on open, live rows while a turn runs, each swapped for its rich block
// after thread.finished (nothing twice), the raw view, and a question card driven by keys.
// Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { install, text, $, $$, everything } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
const keys = new Set();
doc.addEventListener = (type, fn) => { if (type === "keydown") keys.add(fn); };
doc.removeEventListener = (type, fn) => { if (type === "keydown") keys.delete(fn); };
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
const store = new Map();
Object.assign(globalThis, {
  // An svg with a circle in it, which icons.js's mark() colours.
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
  addEventListener: () => {}, removeEventListener: () => {},
  localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
});

// What the fake lacks and the view uses: siblings, insertBefore, replaceWith, after.
const E = /** @type {any} */ (globalThis).Element.prototype;
const sibs = n => (n.parentNode ? n.parentNode.childNodes : []);
const El = /** @type {any} */ (globalThis).Element;
Object.defineProperties(E, {
  previousElementSibling: { get() { const s = sibs(this); for (let i = s.indexOf(this) - 1; i >= 0; i--) if (s[i] instanceof El) return s[i]; return null; } },
  nextElementSibling: { get() { const s = sibs(this); for (let i = s.indexOf(this) + 1; i < s.length; i++) if (s[i] instanceof El) return s[i]; return null; } },
  nextSibling: { get() { const s = sibs(this); return s[s.indexOf(this) + 1] || null; } },
  lastElementChild: { get() { const c = this.children; return c[c.length - 1] || null; } },
});
E.insertBefore = function (n, ref) { if (!ref) { this.append(n); return n; } n.remove(); this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); n.parentNode = this; return n; };
E.replaceWith = function (n) { const p = this.parentNode; if (!p) return; p.insertBefore(n, this); this.remove(); };
E.after = function (n) { this.parentNode.insertBefore(n, this.nextSibling); };

/** The event stream: one fake EventSource, fed by hand. */
let evId = 0;
class FakeES { constructor() { FakeES.last = this; this.l = new Map(); this.readyState = 1; } addEventListener(t, f) { (this.l.get(t) || this.l.set(t, []).get(t)).push(f); } }
/** @type {any} */ (FakeES).OPEN = 1;
Object.assign(globalThis, { EventSource: FakeES });
const emit = (type, payload, thread = SID) => { for (const f of FakeES.last.l.get(type) || []) f({ data: JSON.stringify({ id: ++evId, type, thread, at: Date.now(), payload }) }); };

const fx = JSON.parse(readFileSync(new URL("./fixtures/session-blocks.json", import.meta.url), "utf8"));
const SID = fx.session.id;
const T0 = Date.now() - 60_000;

// The second read: the open turn again (seen), the closed turn, the new message, its reply.
const second = [
  ...fx.blocks.slice(0, -1),
  { seq: 19, kind: "turn", ts: fx.blocks[0].ts, duration_ms: 19000, tokens: { input: 18420, output: 912 }, model: "sample-model" },
  { seq: 19, kind: "user", ts: T0, text: "Now add Saturday slots" },
  { seq: 20, kind: "text", ts: T0 + 1000, message: "msg_10", text: "Adding Saturday slots." },
  { seq: 21, kind: "tool", ts: T0 + 2000, id: "toolu_20", tool: "Bash", input: { command: "npm test" }, output: "# tests 15\n# pass 15", error: false, done_ts: T0 + 3000, duration_ms: 1000 },
  { seq: 22, kind: "text", ts: T0 + 4000, message: "msg_11", text: "Done, 15 tests pass." },
  { seq: 22, kind: "turn", ts: T0, duration_ms: 4000, tokens: { input: 2100, output: 88 }, model: "sample-model", open: true },
];

const calls = [];
let reads = 0;
// The second session: a live headless thread the transcript read cannot find yet.
const LIVE = "9d0e4c1a-live-thread";
let liveReads = 0;
const liveBlocks = [
  { seq: 0, kind: "user", ts: T0, text: "ask" },
  { seq: 1, kind: "text", ts: T0 + 1000, message: "msg_q", text: "Two questions first." },
  { seq: 2, kind: "tool", ts: T0 + 2000, id: "toolu_q", tool: "AskUserQuestion", input: { questions: [] }, output: "answered", error: false, done_ts: T0 + 3000, duration_ms: 1000 },
  { seq: 3, kind: "turn", ts: T0, duration_ms: 3000, tokens: { input: 900, output: 40 }, model: "sample-model", open: true },
];
const liveEvents = [
  { id: 1, type: "thread.sent", thread: LIVE, at: T0, payload: { text: "ask", surface: "deck" } },
  { id: 2, type: "thread.text", thread: LIVE, at: T0 + 1000, payload: { message: "msg_q", text: "Two questions first.", done: true } },
  { id: 3, type: "thread.tool", thread: LIVE, at: T0 + 2000, payload: { id: "toolu_q", tool: "AskUserQuestion", phase: "started", summary: "2 questions" } },
];
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  const input = JSON.parse(o.body);
  calls.push({ tool, input });
  let data;
  if (input.thread === LIVE || input.session === LIVE) {
    if (tool === "threads.get") data = { thread: { id: LIVE, name: null, cwd: fx.session.cwd, status: "running", holder: null, agent: null }, events: liveEvents, asks: [fx.asks[0]] };
    else if (tool === "recall.transcript") {
      if (liveReads++ === 0) return { status: 404, statusText: "", json: async () => ({ error: { code: "not_found", message: "no transcript for this session yet" } }) };
      data = { session: { id: LIVE, cwd: fx.session.cwd }, blocks: liveBlocks, next: 3, first: 0 };
    } else if (tool === "threads.asks") data = [fx.asks[0]];
    else data = tool === "memory.facts" ? { facts: [] } : {};
    return { status: 200, statusText: "", json: async () => ({ data }) };
  }
  if (tool === "system.info") data = owner ? { owner: { name: owner } } : {};
  else if (tool === "threads.get") data = { thread: { id: SID, name: "order form fix", cwd: fx.session.cwd, status: "running", holder: "deck", agent: null }, events: [], asks: [] };
  else if (tool === "recall.transcript") data = reads++ === 0 ? { session: fx.session, blocks: fx.blocks, next: 0, first: 0 } : { session: fx.session, blocks: second, next: 19, first: 0 };
  else if (tool === "threads.asks") data = fx.asks.filter(a => a.kind === "question");
  else if (tool === "memory.facts") data = { facts: [] };
  else data = {};
  return { status: 200, statusText: "", json: async () => ({ data }) };
});
let owner = "alex"; // system.info is read once per page (lib/names.js), so one owner for the file
const wait = (ms = 10) => new Promise(r => setTimeout(r, ms));

const { mountSession } = await import("./session.js");
const container = new El("div");
doc.body.append(container);
const stop = mountSession(container, { thread: SID, project: null, onBack() {} });
await wait();

test("chips: the owner's initial for you, the Vyre mark for replies", () => {
  assert.equal(text($(container, ".cv-user .msg-av")), "A");
  assert.ok($(container, ".cv-head .cv-av-vyre svg"));
});

test("open: blocks as rows, one Vyre header per run, tool runs folded, the turn footer, never claude", async () => {
  assert.equal($$(container, ".cv-user").length, 1);
  assert.equal($$(container, ".cv-head").length, 1);
  assert.match(text($(container, ".cv-head")), /Vyre/);
  // Changed on purpose (the chat view, 27 Sep): runs of tool calls fold into one quiet row each,
  // the todo list stays out (it is the thing to read), and a fold's cards are built when it opens.
  const runs = $$(container, ".cv-run");
  assert.equal(runs.length, 2);
  assert.match(text(runs[0]), /^Read 1 file, searched 1 time/);
  assert.match(text(runs[1]).trim(), /^Edited 1 file, ran 1 command, fetched 1 page, used 1 tool · [\d.]+ s$/);
  assert.equal($$(container, ".cv-tool").length, 1, "the todo list, not folded");
  for (const r of runs) await $(r, ".cv-run-head").click();
  assert.equal($$(container, ".cv-run[data-open]").length, 2);
  assert.equal($$(container, ".cv-tool").length, 7);
  assert.equal($$(container, ".cv-think").length, 1);
  assert.match(text($(container, ".cv-tool[data-tool=Bash]")), /\$ npm test -- src\/order/);
  assert.match(text($(container, ".cv-tool[data-tool=Bash]")), /2\.4 s/);
  assert.equal($$(container, ".cv-tool[data-tool=Edit] .cv-dl-add").length, 1);
  assert.equal($$(container, ".cv-todo-completed").length, 1);
  assert.equal($$(container, ".cv-todo-in_progress").length, 1);
  assert.match(text($(container, ".cv-turn")), /19 s · 18k in, 912 out/);
  // The composer (composer.js, not this view's) is left out: its hint names the terminal's commands.
  assert.doesNotMatch(everything($(container, ".session-head")) + everything($(container, ".thread-view")) + everything($(container, ".lease-bar")), /claude/i);
  assert.ok(calls.some(c => c.tool === "recall.transcript" && c.input.session === SID && c.input.limit === 400));
});

test("live: text streams, a tool card runs, then the transcript's blocks replace them in place", async () => {
  emit("thread.sent", { text: "Now add Saturday slots", surface: "deck" });
  emit("thread.text", { message: "msg_10", delta: "Adding Saturday" });
  await wait(150);
  assert.ok($(container, ".cv-live"), "a live reply");
  assert.ok($(container, ".cv-live .msg-cursor"), "with a cursor");
  emit("thread.tool", { id: "toolu_20", tool: "Bash", phase: "started", summary: "npm test", destination: null });
  assert.equal($(container, ".cv-tool[data-state=running]") !== null, true);
  emit("thread.tool", { id: "toolu_20", phase: "done", error: false });
  emit("thread.text", { message: "msg_10", text: "Adding Saturday slots.", done: true });
  emit("thread.finished", { ok: true, cost_usd: 0.042, duration_ms: 4000, tokens: { input: 2100, output: 88 } });
  await wait(50);
  const all = text(container);
  assert.equal(all.split("Now add Saturday slots").length - 1, 1, "the message once");
  assert.equal(all.split("Adding Saturday slots.").length - 1, 1, "the reply once");
  assert.equal($$(container, ".cv-live").length, 0, "no live rows left");
  assert.equal($$(container, ".cv-tool").length, 8);
  assert.match(text($(container, ".cv-tool[data-tool=Bash][data-state=done] .cv-out")) + text(container), /# pass 15/);
  const turns = $$(container, ".cv-turn").map(text);
  assert.equal(turns.length, 2, "the first turn closed, the second open: two footers");
  assert.match(turns[1], /\$0\.042/, "the cost from thread.finished");
  assert.equal($$(container, ".cv-head").length, 2, "one header per reply");
  // Order: the new message, its reply, its tool, the later text, the footer.
  const order = container.querySelectorAll(".cv-row").map(n => n.className.split(" ").find(c => /^cv-(user|head|text|tool|turn|think)$/.test(c)));
  assert.deepEqual(order.slice(-6), ["cv-user", "cv-head", "cv-text", "cv-tool", "cv-text", "cv-turn"]);
});

test("raw view: the same blocks as the terminal prints them, remembered", async () => {
  const btn = $(container, ".cv-raw-toggle");
  await btn.click();
  assert.ok($(container, ".cv-raw-on"));
  const raw = text($(container, ".cv-raw"));
  assert.match(raw, /⏺ Bash\(npm test -- src\/order\)/);
  assert.match(raw, /> Now add Saturday slots/);
  assert.equal(store.get("vyre.chat.raw"), "1");
  await $(container, ".cv-raw-toggle").click();
  assert.equal($(container, ".cv-raw-on"), null);
  assert.equal(store.get("vyre.chat.raw"), "0");
});

test("a question: raised, filled from threads.asks, answered by keys, folded when answered elsewhere", async () => {
  const bare = structuredClone(fx.asks[0]);
  for (const q of bare.questions) for (const o of q.options) delete o.preview;
  emit("ask.raised", { ask: bare.id, kind: "question", tool: "AskUserQuestion", summary: "2 questions", questions: bare.questions });
  await wait();
  const card = $(container, ".cv-q");
  assert.ok(card);
  assert.ok($(card, ".cv-q-preview"), "previews read from threads.asks");
  const press = k => { const e = /** @type {any} */ (new Event("keydown")); e.key = k; e.target = doc.body; for (const f of keys) f(e); return e; };
  assert.equal(press("1").defaultPrevented, true);
  assert.match(text(card), /2 of 2/);
  const typing = /** @type {any} */ (new Event("keydown")); typing.key = "1"; typing.target = new El("textarea");
  for (const f of keys) f(typing);
  assert.match(text(card), /2 of 2/, "keys typed into the composer are not the card's");
  emit("ask.answered", { ask: bare.id, decision: "allow", answers: { "Which pickup slots should the form offer?": "Mornings only", "Who should get the order emails?": "kit" } });
  assert.match(text(card), /Answered/);
  assert.match(text(card), /Mornings only/);
  stop();
  assert.equal(keys.size, 0, "cleanup drops the key listener");
});

test("a live thread the transcript cannot find yet: threads.get's events drawn, then swapped for blocks", async () => {
  const box = new El("div");
  doc.body.append(box);
  const stop2 = mountSession(box, { thread: LIVE, project: null, onBack() {} });
  await wait(30);
  const you = $(box, ".cv-user");
  assert.ok(you, "the person's own message shows");
  assert.match(text(you), /you/);
  assert.match(text(you), /ask/);
  assert.equal(text($(you, ".msg-av")), "A", "the owner's initial");
  assert.match(text(box), /Two questions first\./);
  assert.ok($(box, ".cv-tool[data-tool=AskUserQuestion]"));
  assert.ok($(box, ".cv-q"), "the open question card");
  emit("thread.finished", { ok: true, cost_usd: 0.01, duration_ms: 3000, tokens: { input: 900, output: 40 } }, LIVE);
  await wait(30);
  const all = text($(box, ".thread-view"));
  assert.equal(all.split("Two questions first.").length - 1, 1, "the reply once");
  assert.equal($$(box, ".cv-user").length, 1, "the message once");
  assert.equal($$(box, ".cv-tool").length, 1, "the tool once");
  assert.match(text($(box, ".cv-tool")), /done/);
  assert.equal($$(box, ".cv-turn").length, 1);
  assert.ok($(box, ".cv-q"), "the card stays");
  stop2();
});
