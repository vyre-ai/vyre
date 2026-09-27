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
// The third session: an ADR 0030 thread (provider, model, auth, state, queue, interrupt).
const NEW = "4b7e2a90-sdk-thread";
let interruptMissing = false;
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  const input = JSON.parse(o.body);
  calls.push({ tool, input });
  let data;
  if (input.thread === NEW || input.session === NEW) {
    if (tool === "threads.interrupt" && interruptMissing) return { status: 404, statusText: "", json: async () => ({ error: { code: "no_such_tool", message: "no tool threads.interrupt" } }) };
    if (tool === "threads.get") data = { thread: { id: NEW, name: "Q3 report and Estate intake", cwd: "/home/alex/work/harlow-legal", status: "idle", holder: null, agent: "kit" }, events: [], asks: [] };
    else if (tool === "recall.transcript") data = { session: { id: NEW, cwd: "/home/alex/work/harlow-legal" }, blocks: [], next: 0, first: 0 };
    else if (tool === "threads.asks") data = [];
    else if (tool === "threads.answer") data = { answered: true };
    else data = tool === "memory.facts" ? { facts: [] } : {};
    return { status: 200, statusText: "", json: async () => ({ data }) };
  }
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

// ---- an ADR 0030 session: chip, state word, fold rows, queue, Stop, asks answered elsewhere ----

// Mounted in the first test below, so the tests above see only their own key listeners.
const box3 = new El("div");
doc.body.append(box3);
let stop3 = () => {};
const at = (type, payload, when) => { for (const f of FakeES.last.l.get(type) || []) f({ data: JSON.stringify({ id: ++evId, type, thread: NEW, at: when ?? Date.now(), payload }) }); };
const press3 = k => { const e = /** @type {any} */ (new Event("keydown")); e.key = k; e.target = doc.body; for (const f of keys) f(e); return e; };
const stopBtn = () => $(box3, ".composer-stop");

test("the header chip names provider, model and auth, and the state word follows the session", async () => {
  stop3 = mountSession(box3, { thread: NEW, project: null, onBack() {} });
  await wait(30);
  assert.equal($(box3, ".cv-chip"), null, "nothing known, no chip");
  assert.match(text($(box3, ".cv-state")), /^idle$/);
  assert.equal(stopBtn().hidden, true, "no Stop while idle");
  at("thread.started", { provider: "claude", model: "claude-opus-4-5", auth: "subscription" });
  assert.equal(text($(box3, ".cv-chip")), "Claude · opus · subscription");
  assert.match(text($(box3, ".cv-state")), /^starting$/);
  at("thread.stopped", { reason: "idle" });
  assert.match(text($(box3, ".cv-state")), /^idle$/);
  assert.match(text($(box3, ".lease-bar")), /Resumes on your next message/);
});

test("thinking folds to its length, a run of tools is one row that counts up, the turn ends with time and tokens", async () => {
  const t0 = Date.now() - 60_000;
  at("thread.sent", { text: "Rebuild the intake for the Estate branch", surface: "deck" }, t0);
  assert.equal(stopBtn().hidden, false, "Stop while a turn runs");
  at("thread.text", { kind: "reasoning", message: "m1", text: "Weighing the two forms", done: true }, t0 + 1000);
  at("thread.text", { message: "m1", text: "Using Estate intake v2.", done: true }, t0 + 9000);
  assert.equal(text($(box3, ".cv-think-head")), "Thinking · 8 s");
  at("thread.tool", { call: "c1", name: "Read", status: "running", summary: "src/intake/schema.ts" }, t0 + 10_000);
  at("thread.tool", { call: "c1", status: "completed" }, t0 + 10_400);
  at("thread.tool", { call: "c2", name: "Bash", status: "running", summary: "npm run build" }, Date.now() - 42_000);
  const run = $(box3, ".cv-run");
  assert.ok(run, "two calls in a row fold into one row");
  assert.match(text(run).trim(), /^Running npm run build · 0:4\d$/);
  assert.equal($$(box3, ".cv-tool").length, 0, "closed: its cards are not built");
  at("thread.tool", { call: "c2", status: "completed" });
  assert.match(text($(box3, ".cv-run")).trim(), /^Read 1 file, ran 1 command · \d+ s$/);
  await $(box3, ".cv-run-head").click();
  assert.equal($$(box3, ".cv-run .cv-tool").length, 2, "open: the calls as rows");
  at("thread.finished", { ok: true, duration_ms: 72_000, tokens: { input: 18_400, output: 900 } });
  await wait(20);
  assert.match(text($$(box3, ".cv-turn").at(-1)), /^1 min 12 s · 18k in, 900 out$/);
  assert.equal(stopBtn().hidden, true, "no Stop once the turn is over");
});

test("queued rows sit above the composer; their buttons wait for the sessions update", async () => {
  at("thread.queued", { uuid: "q1", text: "Then open a PR against main" });
  const row = $(box3, ".cv-queued-row");
  assert.ok(row);
  assert.match(text(row), /^Queued\s*Then open a PR against main/);
  for (const [cls, label] of [[".cv-q-edit", "Edit"], [".cv-q-take", "Take back"], [".cv-q-now", "Send now"]]) {
    const b = $(row, cls);
    assert.equal(text(b), label);
    assert.equal(b.disabled, true);
    assert.equal(b.getAttribute("title"), "Needs the sessions update");
  }
  assert.doesNotMatch(text($(box3, ".thread-view")), /Then open a PR/, "waiting is not in the timeline");
  at("thread.sent", { uuid: "q1", text: "Then open a PR against main", surface: "deck" });
  assert.equal($(box3, ".cv-queued").hidden, true);
  assert.match(text($$(box3, ".cv-user").at(-1)), /Then open a PR against main/);
});

test("Stop interrupts the turn, which reads 'Stopped by you'; without threads.interrupt, Esc falls back to threads.stop", async () => {
  assert.equal(stopBtn().hidden, false);
  await stopBtn().click();
  await wait();
  assert.ok(calls.some(c => c.tool === "threads.interrupt" && c.input.thread === NEW));
  at("thread.finished", { ok: false, canceled: true, reason: "interrupt" });
  await wait(20);
  assert.match(text($$(box3, ".cv-turn").at(-1)), /^Stopped by you/);
  interruptMissing = true;
  at("thread.sent", { text: "One more thing", surface: "deck" });
  assert.equal(press3("Escape").defaultPrevented, true);
  await wait();
  assert.ok(calls.some(c => c.tool === "threads.stop" && c.input.thread === NEW), "threads.stop when the Switchboard has no interrupt");
  at("thread.stopped", { reason: "stop" });
  await wait(20);
  assert.match(text($$(box3, ".cv-turn").at(-1)), /^Stopped by you/);
  assert.match(text($(box3, ".cv-state")), /^stopped$/);
});

test("an inline ask: A allows, D denies, and one answered on another screen says where", async () => {
  at("ask.raised", { ask: "ask_n1", kind: "permission", tool: "Bash", summary: "git push origin q3-report" });
  await wait();
  const cards = () => $$(box3, ".cv-ask");
  assert.equal(cards().length, 1);
  assert.equal(press3("a").defaultPrevented, true);
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.answer").at(-1).input, { ask: "ask_n1", decision: "allow", surface: "deck" });
  at("ask.answered", { ask: "ask_n1", decision: "allow", by: "deck" });
  assert.doesNotMatch(text(cards()[0]), /Answered from/, "answered here: nothing about another screen");
  at("ask.raised", { ask: "ask_n2", kind: "permission", tool: "Bash", summary: "npm publish" });
  await wait();
  press3("d");
  await wait();
  assert.equal(calls.filter(c => c.tool === "threads.answer").at(-1).input.decision, "deny");
  at("ask.raised", { ask: "ask_n3", kind: "permission", tool: "Bash", summary: "rm -rf dist" });
  await wait();
  at("ask.answered", { ask: "ask_n3", decision: "allow", by: "capsule" });
  const last = cards().at(-1);
  assert.match(text(last), /Allowed once/);
  assert.match(text(last), /Answered from the Capsule · \d\d:\d\d/);
  stop3();
});
