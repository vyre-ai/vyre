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
/** Where go() sent the page (a rewind stays on the same thread: nothing goes here). */
const went = [];
Object.defineProperty(globalThis, "history", { value: { state: null, pushState: (_s, _t, url) => went.push(url), replaceState: () => {} },
  configurable: true, writable: true });

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

/** The event stream, fed by hand: api.js hear() hands an event to the listeners as the stream does. */
let evId = 0;
const { hear, heardResume } = await import("../js/api.js");
const emit = (type, payload, thread = SID) => hear(/** @type {any} */ ({ id: ++evId, type, thread, at: Date.now(), payload }));

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
const NOREC = "norec-server-thread";
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
/** What threads.tasks answers for it (sessions 034c71e5). */
let newTasks = /** @type {any[]} */ ([]);
let interruptMissing = false;
/** Tools this box answers "no such tool" for (a box before the sessions update has none of them; this one has some). */
const MISSING = new Set(["threads.unqueue"]);
/** sight.targets/sight.frame (cohesion item 1/18): set by the sight test only; every other test's
 * session sees no target (sight.targets carries no thread, so this can't be scoped like the rest). */
let sightWorld = /** @type {{ targets: any[], frame: (input: any) => any } | null} */ (null);
/** "@role" (teammates.md section 2): set by the teammate test only. hasTeammate answers team.ask
 * for NEW's project (harlow-legal); defaultOn answers team.default.get; adds records team.add calls. */
let teamWorld = /** @type {{ hasTeammate: boolean, defaultOn: boolean, adds: any[] } | null} */ (null);
// The fourth session: one the stream drops and resumes (ADR 0029 R1). What the box holds is
// changed by the test between reads.
const RES = "5e6f7a8b-resume-thread";
const res = {
  events: /** @type {any[]} */ ([{ id: 10, type: "thread.finished", thread: RES, at: T0 + 2000, payload: { ok: true } }]),
  blocks: /** @type {any[]} */ ([
    { seq: 0, kind: "user", ts: T0, text: "Open the Northwind Bakery order form" },
    { seq: 1, kind: "text", ts: T0 + 1000, message: "msg_r0", text: "It is open." },
    { seq: 1, kind: "turn", ts: T0, duration_ms: 2000, tokens: { input: 300, output: 20 }, model: "sample-model" },
  ]),
  next: 2,
  asks: /** @type {any[]} */ ([]),
};
// The fifth session: reopened while an Edit waits on Allow, after the person steered a message
// and queued another (the screenshot run's shape: threads.get holds both, the transcript neither).
const REOPEN = "6a7b8c9d-reopen-thread";
const reopen = {
  thread: { id: REOPEN, name: "Northwind specials", cwd: "/home/alex/work/northwind", status: "waiting", canonical_status: "asking", holder: "deck", agent: null },
  events: [
    { id: 1, type: "thread.sent", thread: REOPEN, at: T0, payload: { text: "demo", surface: "deck", uuid: "u-demo" } },
    { id: 2, type: "thread.turn", thread: REOPEN, at: T0, payload: { turn: `${REOPEN}:1`, uuid: "u-demo", text: "demo" } },
    // An earlier steer Claude took in, and a queued row taken back: neither is pending now.
    { id: 3, type: "thread.sent", thread: REOPEN, at: T0 + 100, payload: { text: "read the menu first", surface: "deck", uuid: "s-old", via: "steer" } },
    { id: 4, type: "thread.steered", thread: REOPEN, at: T0 + 200, payload: { uuid: "s-old", step: 0 } },
    { id: 5, type: "thread.queued", thread: REOPEN, at: T0 + 300, payload: { queued: 3, uuid: "q-old", text: "never mind", surface: "deck" } },
    { id: 6, type: "thread.unqueued", thread: REOPEN, at: T0 + 400, payload: { queued: 3, uuid: "q-old", reason: "taken" } },
    { id: 7, type: "thread.tool", thread: REOPEN, at: T0 + 1000, payload: { call: "toolu_e", id: "toolu_e", tool: "Edit", name: "Edit", phase: "started", status: "running", summary: "Edit menu.md" } },
    { id: 8, type: "ask.raised", thread: REOPEN, at: T0 + 1100, payload: { ask: "ask_e", kind: "permission", tool: "Edit", summary: "menu.md", tool_use_id: "toolu_e" } },
    { id: 9, type: "thread.status", thread: REOPEN, at: T0 + 1100, payload: { status: "asking" } },
    { id: 10, type: "thread.sent", thread: REOPEN, at: T0 + 2000, payload: { text: "use the rye price too", surface: "deck", uuid: "s-new", via: "steer" } },
    { id: 11, type: "thread.queued", thread: REOPEN, at: T0 + 3000, payload: { queued: 5, uuid: "q-new", text: "then check the hours", surface: "deck" } },
  ],
  asks: [{ id: "ask_e", thread: REOPEN, kind: "permission", tool: "Edit", summary: "menu.md", destination: "/home/alex/work/northwind/menu.md", always: true,
    anchor: { tool_use_id: "toolu_e", event: 8 }, detail: { file: "/home/alex/work/northwind/menu.md", old: "- Summer berry tart, 5.00", new: "- Pumpkin loaf, 5.50" } }],
  blocks: [
    { seq: 0, kind: "user", ts: T0, text: "demo" },
    { seq: 1, kind: "user", ts: T0 + 100, text: "read the menu first", steered: true },
    { seq: 2, kind: "tool", ts: T0 + 1000, id: "toolu_e", tool: "Edit", input: { file_path: "/home/alex/work/northwind/menu.md", old_string: "- Summer berry tart, 5.00", new_string: "- Pumpkin loaf, 5.50" } },
    { seq: 2, kind: "turn", ts: T0, open: true },
  ],
};
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  const input = JSON.parse(o.body);
  calls.push({ tool, input });
  let data;
  // sessions.models.get names no thread: the per-purpose map, and the box's aliases (composer.js's
  // createAndAsk reads aliases[1] for a guessed teammate's model, never a literal - cohesion-drift).
  if (tool === "sessions.models.get") return { status: 200, statusText: "", json: async () => ({ data: {
    aliases: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }],
    purposes: { chat: { model: "opus", from: "config:chat" }, job: { model: "claude-haiku-4-5", from: "config:job" } }, projects: {} } }) };
  // sight.targets/sight.frame carry no thread at all: answered here, ahead of every thread branch.
  if (tool === "sight.targets") return { status: 200, statusText: "", json: async () => ({ data: { targets: sightWorld?.targets || [] } }) };
  if (tool === "sight.frame") return { status: 200, statusText: "", json: async () => ({ data: sightWorld?.frame(input) || { target: input.target, image: null } }) };
  // team.ask/team.default.get/team.add (teammates.md section 2) carry no thread either.
  if (tool === "team.ask") {
    if (teamWorld?.hasTeammate) return { status: 200, statusText: "", json: async () => ({ data: { request: "req_1", state: "queued", position: 0 } }) };
    // core/team's own message, no word "tool" in it: never read as a missing-tool 404 (session.js's
    // own recall.transcript not_found does the same distinction; caps.js's isMissing agrees).
    return { status: 404, statusText: "", json: async () => ({ error: { code: "not_found", message: `harlow-legal has no teammate ${input.to}` } }) };
  }
  if (tool === "team.list") return { status: 200, statusText: "", json: async () => ({ data: [{ role: "design", agent: "design-harlow-legal" }, { role: "review", agent: "review-harlow-legal" }] }) };
  if (tool === "agents.list") return { status: 200, statusText: "", json: async () => ({ data: [{ name: "kit", kind: "agent" }] }) };
  if (tool === "agents.ask") return { status: 200, statusText: "", json: async () => ({ data: { thread: "thr_kit", state: "sent" } }) };
  if (tool === "team.default.get") return { status: 200, statusText: "", json: async () => ({ data: { project: input.project, enabled: teamWorld?.defaultOn !== false } }) };
  if (tool === "team.add") {
    teamWorld?.adds?.push(input);
    if (teamWorld) teamWorld.hasTeammate = true;
    return { status: 200, statusText: "", json: async () => ({ data: { agent: `${input.role}-${input.project}`, project: input.project, role: input.role } }) };
  }
  if (input.thread === RES || input.session === RES) {
    if (tool === "threads.get") data = { thread: { id: RES, name: "Northwind order form", cwd: "/home/alex/work/northwind", status: "idle", canonical_status: "waiting", holder: null, agent: null },
      events: res.events.filter(e => e.id > (input.since ?? 0)), asks: res.asks };
    else if (tool === "recall.transcript") {
      const from = input.from ?? 0;
      data = { session: { id: RES, cwd: "/home/alex/work/northwind" }, blocks: res.blocks.filter(b => b.seq >= from), next: res.next, first: 0 };
    } else if (tool === "threads.asks") data = res.asks;
    else data = tool === "memory.facts" ? { facts: [] } : {};
    return { status: 200, statusText: "", json: async () => ({ data }) };
  }
  if (input.thread === REOPEN || input.session === REOPEN) {
    if (tool === "threads.get") data = { thread: reopen.thread, events: reopen.events.filter(e => e.id > (input.since ?? 0)), asks: reopen.asks };
    else if (tool === "recall.transcript") data = { session: { id: REOPEN, cwd: reopen.thread.cwd }, blocks: reopen.blocks.filter(b => b.seq >= (input.from ?? 0)), next: 3, first: 0 };
    else if (tool === "threads.asks") data = reopen.asks;
    else data = tool === "memory.facts" ? { facts: [] } : {};
    return { status: 200, statusText: "", json: async () => ({ data }) };
  }
  if (input.thread === NEW || input.session === NEW) {
    if (tool === "threads.interrupt" && interruptMissing) return { status: 404, statusText: "", json: async () => ({ error: { code: "no_such_tool", message: "no tool threads.interrupt" } }) };
    if (MISSING.has(tool)) return { status: 404, statusText: "", json: async () => ({ error: { code: "no_such_tool", message: "no such tool here" } }) };
    if (tool === "threads.get") data = { thread: { id: NEW, name: "Q3 report and Estate intake", cwd: "/home/alex/work/harlow-legal", status: "idle", canonical_status: "waiting", holder: null, agent: "kit", project: "harlow-legal" }, events: [], asks: [] };
    else if (tool === "recall.transcript") data = { session: { id: NEW, cwd: "/home/alex/work/harlow-legal" }, blocks: [], next: 0, first: 0 };
    else if (tool === "threads.asks") data = [];
    else if (tool === "threads.answer") data = { answered: true };
    // core/switchboard's answers (work/sessions): the box mints the uuid. A steer {sent, steered,
    // thread, uuid, turn}; a queued message {sent: false, queued: true, queued_id, uuid, thread, busy}.
    else if (tool === "threads.send") data = input.mode === "queue"
      ? { sent: false, queued: true, queued_id: 41, uuid: "box-q41", thread: NEW, name: "Q3 report", busy: "working", note: "Q3 report is working on something." }
      : input.mode === "steer" ? { sent: true, steered: true, thread: NEW, uuid: "box-steer-1", turn: `${NEW}:9` } : { sent: true, thread: NEW };
    else if (tool === "threads.rewind") data = input.restore === "code"
      ? { rewound: true, thread: NEW, uuid: input.uuid, restore: "code", files: { restored: true, files_changed: ["src/intake/estate.ts", "src/intake/forms.ts"] } }
      : { rewound: true, thread: NEW, uuid: input.uuid, text: "Use Estate intake v2 instead",
        ...(input.restore ? { restore: input.restore, files: { restored: true, files_changed: ["src/intake/estate.ts"] } } : {}) };
    else if (tool === "threads.commands") data = { thread: NEW, commands: [{ name: "compact", description: "Clear history but keep a summary", argumentHint: "<instructions>" }] };
    else if (tool === "threads.model") data = { thread: NEW, model: input.model };
    else if (tool === "threads.mode") data = { thread: NEW, mode: input.mode };
    // Sessions 034c71e5's answers.
    else if (tool === "threads.tasks") data = { thread: NEW, tasks: newTasks };
    else if (tool === "threads.kill-task") data = { thread: NEW, task: input.task, killed: true };
    else if (tool === "threads.thinking") data = { thread: NEW, thinking: input.on };
    else if (tool === "threads.shell") data = { thread: NEW, code: 1, output: "1 failing\n  estate intake: total" };
    else if (tool === "threads.remember") data = { thread: NEW, scope: input.scope, file: `/home/alex/work/harlow-legal/${input.scope === "local" ? "CLAUDE.local.md" : "CLAUDE.md"}` };
    else data = tool === "memory.facts" ? { facts: [] } : {};
    return { status: 200, statusText: "", json: async () => ({ data }) };
  }
  if (input.thread === NOREC || input.session === NOREC) {
    if (tool === "threads.get") data = { thread: { id: NOREC, name: "server thread", cwd: "/srv/w", status: "idle", canonical_status: "waiting", holder: null, agent: null },
      events: [{ id: 1, type: "thread.sent", thread: NOREC, at: T0, payload: { text: "hello from the server", surface: "deck" } }], asks: [] };
    else if (tool === "recall.transcript" || tool === "recall.thread") return { status: 500, statusText: "", json: async () => ({ error: { code: "internal", message: "no paired Mac" } }) };
    else data = tool === "memory.facts" ? { facts: [] } : {};
    return { status: 200, statusText: "", json: async () => ({ data }) };
  }
  if (input.thread === LIVE || input.session === LIVE) {
    if (tool === "threads.get") data = { thread: { id: LIVE, name: null, cwd: fx.session.cwd, status: "running", canonical_status: "working", holder: null, agent: null }, events: liveEvents, asks: [fx.asks[0]] };
    else if (tool === "recall.transcript") {
      if (liveReads++ === 0) return { status: 404, statusText: "", json: async () => ({ error: { code: "not_found", message: "no transcript for this session yet" } }) };
      data = { session: { id: LIVE, cwd: fx.session.cwd }, blocks: liveBlocks, next: 3, first: 0 };
    } else if (tool === "threads.asks") data = [fx.asks[0]];
    else data = tool === "memory.facts" ? { facts: [] } : {};
    return { status: 200, statusText: "", json: async () => ({ data }) };
  }
  if (tool === "system.info") data = owner ? { owner: { name: owner } } : {};
  else if (tool === "threads.get") data = { thread: { id: SID, name: "order form fix", cwd: fx.session.cwd, status: "running", canonical_status: "working", holder: "deck", agent: null }, events: [], asks: [] };
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

test("avatars (ADR 0043): the person's circle for you; a chat in no project wears the assistant on its replies and header, never the dashed draft tile", () => {
  const you = $(container, ".cv-user .msg-av");
  assert.equal(you.getAttribute("data-family"), "person");
  assert.ok($(you, "svg"), "drawn, not a letter");
  assert.equal(you.getAttribute("title"), "alex");
  const reply = $(container, ".cv-head .msg-av");
  assert.equal(reply.getAttribute("data-family"), "assistant");
  assert.ok(!reply.hasAttribute("data-draft"), "no project yet: not the dashed draft tile, which read as a warning");
  assert.ok($(reply, "svg"));
  const head = $(container, ".cv-head-av");
  assert.equal(head.getAttribute("data-family"), "assistant", "the session header wears the same one");
  assert.match(text($(container, ".cv-num")), /^#[0-9a-z-]{6}$/, "and the session's short id beside its title");
});

test("filed into a project (thread.picked): the replies and header take that project's tile, in place", async () => {
  emit("thread.picked", { project: "harlow-legal", thread: SID });
  await wait(30);
  const reply = $(container, ".cv-head .msg-av");
  assert.equal(reply.getAttribute("data-family"), "project");
  assert.ok(!reply.hasAttribute("data-draft"), "solid now");
  assert.ok(!$(container, ".cv-head-av").hasAttribute("data-draft"));
  assert.ok(calls.some(c => c.tool === "projects.list"), "the project's stored seed is read afresh");
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
  assert.equal(text($(runs[1], ".cv-run-sum")), "Edited 1 file, ran 1 command, fetched 1 page, used 1 tool");
  assert.match(text($(runs[1], ".cv-run-meta")), /^[\d.]+ s$/);
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
  // The transcript has not closed the turn and the session runs: no footer until it ends (the live test closes it).
  assert.deepEqual($$(container, ".cv-turn").map(text).filter(Boolean), [], "an open turn has no footer yet");
  // The composer (composer.js, not this view's) is left out: its hint names the terminal's commands.
  assert.doesNotMatch(everything($(container, ".session-head")) + everything($(container, ".thread-view")) + everything($(container, ".lease-bar")), /claude/i);
  assert.ok(calls.some(c => c.tool === "recall.transcript" && c.input.session === SID && c.input.limit === 400));
  // The open thread is reported once (cohesion's context.report), with its folder.
  assert.deepEqual(calls.filter(c => c.tool === "context.report").map(c => c.input), [{ surface: "chat", view: "chat", thread: SID, cwd: fx.session.cwd }]);
});

test("live: text streams, a tool card runs, then the transcript's blocks replace them in place", async () => {
  // api-key billing: the only auth where a $ figure means a real charge, so the footer shows one.
  emit("thread.started", { provider: "claude", model: "claude-sonnet-4-5", auth: "api-key" });
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
  assert.equal($(you, ".msg-av").getAttribute("data-family"), "person", "the person's own avatar");
  assert.match(text(box), /Two questions first\./);
  assert.ok($(box, ".cv-tool[data-tool=AskUserQuestion]"));
  assert.ok($(box, ".cv-q"), "the open question card");
  emit("thread.finished", { ok: true, cost_usd: 0.01, duration_ms: 3000, tokens: { input: 900, output: 40 } }, LIVE);
  await wait(30);
  const all = text($(box, ".thread-view"));
  assert.equal(all.split("Two questions first.").length - 1, 1, "the reply once");
  assert.equal($$(box, ".cv-user").length, 1, "the message once");
  assert.equal($$(box, ".cv-tool").length, 1, "the tool once");
  assert.ok($(box, ".cv-tool[data-state=done]"), "the tool is done");
  assert.equal($$(box, ".cv-turn").length, 1);
  assert.ok($(box, ".cv-q"), "the card stays");
  assert.doesNotMatch(text($(box, ".cv-turn")), /\$/, "no auth known: no $ figure, even with a cost_usd (the user's rule)");
  stop2();
});

// ---- an ADR 0030 session: chip, state word, fold rows, queue, Stop, asks answered elsewhere ----

// Mounted in the first test below, so the tests above see only their own key listeners.
const box3 = new El("div");
doc.body.append(box3);
let stop3 = () => {};
const at = (type, payload, when) => hear(/** @type {any} */ ({ id: ++evId, type, thread: NEW, at: when ?? Date.now(), payload }));
const press3 = k => { const e = /** @type {any} */ (new Event("keydown")); e.key = k; e.target = doc.body; for (const f of keys) f(e); return e; };
const stopBtn = () => $(box3, ".composer-stop");

test("the header chip names provider, model and auth, and the state word follows the session", async () => {
  stop3 = mountSession(box3, { thread: NEW, project: null, projects: [{ slug: "harlow-legal", name: "Harlow Legal" }], onBack() {} });
  await wait(30);
  assert.equal($(box3, ".cv-chip"), null, "nothing known, no chip");
  assert.equal(text($(box3, ".cv-project")), "Harlow Legal", "kit's own thread names its project, once threads.get says which (finding 6)");
  assert.match(text($(box3, ".cv-state")), /^waiting$/, "canonical_status (sessions' 6e2f8a71), not the raw legacy status");
  assert.equal(stopBtn().hidden, true, "no Stop while idle");
  at("thread.started", { provider: "claude", model: "claude-opus-4-5", auth: "subscription" });
  assert.equal(text($(box3, ".cv-chip")), "Claude · opus · subscription");
  assert.match(text($(box3, ".cv-state")), /^starting$/);
  at("thread.stopped", { reason: "idle" });
  assert.match(text($(box3, ".cv-state")), /^paused$/, "the guess mirrors lib/thread-status.js: an idle close is paused, not stopped or failed");
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
  assert.equal(text($(run, ".cv-run-sum")), "Running npm run build");
  assert.match(text($(run, ".cv-run-meta")), /^0:4\d$/);
  assert.equal($$(box3, ".cv-tool").length, 0, "closed: its cards are not built");
  at("thread.tool", { call: "c2", status: "completed" });
  assert.equal(text($(box3, ".cv-run-sum")), "Read 1 file, ran 1 command");
  assert.match(text($(box3, ".cv-run-meta")), /^\d+ s$/);
  await $(box3, ".cv-run-head").click();
  assert.equal($$(box3, ".cv-run .cv-tool").length, 2, "open: the calls as rows");
  at("thread.finished", { ok: true, duration_ms: 72_000, tokens: { input: 18_400, output: 900 } });
  await wait(20);
  assert.match(text($$(box3, ".cv-turn").at(-1)), /^1 min 12 s · 19k tokens$/);
  assert.equal(stopBtn().hidden, true, "no Stop once the turn is over");
});

// Changed on purpose (the composer like Claude Code, 27 Sep): the row reads "Queued for after",
// "Send now" is "Steer now" (threads.send-now in the sessions contract), and each button is on until
// the box says it has no such tool (core/caps.js), not off from the start. Rows are named by the
// box's row id (`queued`): a row without one yet has its buttons off.
test("queued rows sit above the composer: Edit, Take back, Steer now by row id; a server without the tool turns that button off", async () => {
  at("thread.queued", { uuid: "q0", text: "Summarise the Northwind order" });
  assert.equal($(box3, ".cv-queued-row .cv-q-take").disabled, true, "no row id yet");
  at("thread.unqueued", { uuid: "q0", reason: "taken" });
  at("thread.queued", { queued: 7, uuid: "q1", text: "Then open a PR against main", surface: "deck" });
  const row = $(box3, ".cv-queued-row");
  assert.ok(row);
  assert.match(text(row), /^Queued for after this turn\s*Then open a PR against main/);
  for (const [cls, label] of [[".cv-q-edit", "Edit"], [".cv-q-take", "Take back"], [".cv-q-now", "Steer now"]]) {
    const b = $(row, cls);
    assert.equal(text(b), label);
    assert.equal(b.disabled, false, "not known to be missing yet");
  }
  await $(row, ".cv-q-take").click();
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.unqueue").at(-1).input, { thread: NEW, queued: 7 });
  const take = $(box3, ".cv-queued-row .cv-q-take");
  assert.equal(take.disabled, true);
  assert.equal(take.getAttribute("title"), "Needs the sessions update");
  assert.equal($(box3, ".cv-queued-row .cv-q-now").disabled, false, "only that button");
  assert.doesNotMatch(text($(box3, ".thread-view")), /Then open a PR/, "waiting is not in the timeline");
  // Handed over at the turn's end: the row id and uuid, the words are the row's.
  at("thread.sent", { queued: 7, uuid: "q1", via: "turn" });
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
  assert.match(text(last), /Answered from Lumen · \d\d:\d\d/);
  stop3();
});

// ---- the composer like Claude Code: steer, queue, mode, rewind ----------------------------------

test("typing while a turn runs steers it ('steering', then 'you steered here · after 1 step' where it joined); Alt+Enter queues; Shift+Tab; Esc Esc rewinds this thread", async () => {
  const box4 = new El("div");
  doc.body.append(box4);
  const stop4 = mountSession(box4, { thread: NEW, project: null, onBack() {} });
  await wait(30);
  const ta = $(box4, "textarea");
  const key = (k, extra = {}) => { const e = Object.assign(/** @type {any} */ (new Event("keydown")), { key: k, target: ta, ...extra }); ta.dispatchEvent(e); return e; };
  at("thread.sent", { text: "Rebuild the intake for the Estate branch", surface: "deck", uuid: "u-first" });
  at("thread.tool", { call: "s1", name: "Read", status: "running", summary: "src/intake/general.ts" });
  assert.match(ta.placeholder, /^Steer kit, or Alt\+Enter to queue for after$/);
  ta.value = "Use Estate intake v2 instead";
  assert.equal(key("Enter").defaultPrevented, true);
  await wait();
  const sent = calls.filter(c => c.tool === "threads.send").at(-1).input;
  assert.equal(sent.mode, "steer");
  assert.equal(sent.text, "Use Estate intake v2 instead");
  assert.match(sent.uuid, /^[0-9a-f-]{36}$/);
  assert.match(text($(box4, ".cv-steer")).trim(), /^steering · \w+ reads it at its next step$/);
  // The box's own uuid, not the Deck's: the echo and the answer tie it to the words drawn on send.
  at("thread.sent", { text: "Use Estate intake v2 instead", surface: "deck", uuid: "box-steer-1", via: "steer" });
  assert.equal($$(box4, ".cv-user").length, 2, "the echo is the same message");
  assert.match(text($(box4, ".cv-steer")).trim(), /^steering · \w+ reads it at its next step$/, "the echo is not the join");
  at("thread.tool", { call: "s1", status: "completed" });
  // No step on the event: counted here, one call of this turn done.
  at("thread.steered", { uuid: "box-steer-1" });
  assert.equal($$(box4, ".cv-steer").length, 1);
  assert.match(text($(box4, ".cv-steer")).trim(), /^you steered here · after 1 step · \d\d:\d\d$/);
  const order = box4.querySelectorAll(".cv-row").map(n => n.className.split(" ").find(c => /^cv-(user|steer|tool)$/.test(c))).filter(Boolean);
  assert.deepEqual(order, ["cv-user", "cv-tool", "cv-steer", "cv-user"], "the words sit where they joined, after the Read");

  ta.value = "Then open a PR against main";
  key("Enter", { altKey: true, code: "Enter" });
  await wait();
  assert.equal(calls.filter(c => c.tool === "threads.send").at(-1).input.mode, "queue");
  assert.match(text($(box4, ".cv-queued-row")), /Then open a PR against main/);
  assert.equal($(box4, ".cv-queued-row .cv-q-edit").disabled, false, "the answer named the row (queued_id: 41)");
  assert.equal($$(box4, ".cv-queued-row").length, 1);
  at("thread.queued", { queued: 41, uuid: "box-q41", text: "Then open a PR against main", surface: "deck" });
  assert.equal($$(box4, ".cv-queued-row").length, 1, "the event is the same row");

  assert.match(text($(box4, ".composer-mode")), /^Asks first/);
  assert.equal(key("Tab", { shiftKey: true }).defaultPrevented, true);
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.mode").at(-1).input, { thread: NEW, mode: "acceptEdits" });
  assert.match(text($(box4, ".composer-mode")), /^Accepts edits/);

  at("thread.finished", { ok: true, duration_ms: 1000 });
  await wait(20);
  ta.value = "";
  key("Escape"); key("Escape");
  await wait();
  const sheet = $(box4, ".cv-rewind");
  assert.ok(sheet, "Esc Esc opens the rewind sheet");
  assert.match(text(sheet), /Use Estate intake v2 instead/);
  assert.equal($(box4, ".cv-rewind-scrim").hidden, false, "a real overlay (app-design's review), not drawn in the flow");
  await wait();
  // Claude Code's three choices, plus native-core's "Fork from here" (pickers.js: shown whenever
  // onFork is given, disabled until canFork() answers true - session.js always passes onFork now).
  assert.deepEqual($$(box4, ".cv-rw-opt").map(b => text(b)), ["Restore code and conversation", "Restore conversation", "Restore code", "Fork from here"]);
  assert.deepEqual($$(box4, ".cv-rw-opt").map(b => b.disabled), [false, false, false, true], "fork waits on threads.fork answering true");
  assert.equal(text($(box4, ".cv-rw-opt[aria-checked=true]")), "Restore code and conversation", "both is the default");
  press3("Enter");
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.rewind").at(-1).input, { thread: NEW, uuid: "box-steer-1", restore: "both" }, "your server's uuid for the message");
  assert.deepEqual(went, [], "the same thread: nothing opens");
  assert.equal($(box4, ".cv-rewind"), null);
  assert.equal($(box4, ".cv-rewind-scrim").hidden, true);
  assert.equal($$(box4, ".cv-user").length, 1, "the message and everything after it are gone");
  assert.equal($$(box4, ".cv-steer").length, 0);
  assert.equal(ta.value, "Use Estate intake v2 instead", "the words come back to edit");
  assert.match(text($(box4, ".thread-view")), /Rewound to before "Use Estate intake v2 instead" · Restored 1 file/);
  at("thread.rewound", { uuid: "box-steer-1", at: "u-first", restore: "both", files: { restored: true, files_changed: ["src/intake/estate.ts"] } });
  await wait();
  assert.equal($$(box4, ".thread-view .cv-notice").filter(n => /Rewound/.test(text(n))).length, 1, "its event is the same rewind");

  // Code only: the files go back; the conversation, the view and the composer stay.
  ta.value = "";
  key("Escape"); key("Escape");
  await wait();
  press3("ArrowLeft");
  assert.equal(text($(box4, ".cv-rw-opt[aria-checked=true]")), "Restore code");
  const users = $$(box4, ".cv-user").length;
  ta.value = "keep this draft";
  press3("Enter");
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.rewind").at(-1).input, { thread: NEW, uuid: "u-first", restore: "code" });
  assert.equal($(box4, ".cv-rewind"), null);
  assert.equal($$(box4, ".cv-user").length, users, "nothing leaves the view");
  assert.equal(ta.value, "keep this draft", "the composer keeps its words");
  assert.match(text($(box4, ".thread-view")), /Restored 2 files/);
  at("thread.rewound", { uuid: "u-first", restore: "code", files: { restored: true, files_changed: ["src/intake/estate.ts", "src/intake/forms.ts"] } });
  await wait();
  assert.equal($$(box4, ".thread-view .cv-notice").filter(n => /Restored 2 files/.test(text(n))).length, 1, "its event is the same restore");

  // A tap on the scrim closes it too (the tap-on-backdrop convention, lightbox.js), no threads.rewind call.
  ta.value = ""; // the code-restore flow leaves the draft as it was; clear it first, same as the two flows above
  key("Escape"); key("Escape");
  await wait();
  assert.ok($(box4, ".cv-rewind"));
  const rewindCallsBefore = calls.filter(c => c.tool === "threads.rewind").length;
  $(box4, ".cv-rewind-scrim").click();
  assert.equal($(box4, ".cv-rewind"), null);
  assert.equal($(box4, ".cv-rewind-scrim").hidden, true);
  assert.equal(calls.filter(c => c.tool === "threads.rewind").length, rewindCallsBefore, "closed, not chosen");

  // The context meter, only once the box says the share; the model chip follows model.switched.
  assert.equal($(box4, ".cv-context"), null);
  at("thread.usage", { cost_usd: 0.01, total_cost_usd: 0.2, context: { used: 124000, max: 200000, share: 0.62 } });
  await wait();
  assert.equal(text($(box4, ".cv-context")), "62% of context");
  const heads = () => $$(box4, ".cv-head .msg-prov").map(el => text(el));
  at("thread.sent", { text: "Before the switch?", surface: "deck" });
  at("thread.text", { message: "old1", text: "Answered before the switch.", done: true, provider: "claude", model: "claude-opus-4-5" });
  await wait();
  at("model.switched", { model: "haiku", live: true });
  await wait();
  assert.match(text($(box4, ".composer-answer")), /haiku/);
  // One truth (#41): the header, the picker and each reply name a model with the same word, and a switch relabels nothing already said.
  assert.match(text($(box4, ".cv-chip")), /haiku/, "the header follows the switch");
  at("thread.sent", { text: "And now?", surface: "deck" });
  at("thread.text", { message: "new1", text: "Answered after the switch.", done: true, provider: "claude", model: "haiku" });
  await wait();
  assert.deepEqual(heads().slice(-2), ["Claude, opus", "Claude, haiku"], "each reply says the model that answered it, in the header's words");
  await $(box4, ".composer-answer").click();
  await wait();
  assert.ok(calls.some(c => c.tool === "sessions.models.get"), "the picker reads the per-purpose map");
  assert.match(text($(box4, ".composer-menu")), /claude-haiku-4-5/);
  assert.match(text($(box4, ".composer-menu")), /Used for job/);
  ta.value = "";
  stop4();
});

// ---- the stream drops and comes back, or is reset (ADR 0029 R1) ---------------------------------

test("a reconnect or a stream reset re-reads threads.get, threads.asks and the transcript: nothing missing, nothing twice", async () => {
  const box5 = new El("div");
  doc.body.append(box5);
  const stop5 = mountSession(box5, { thread: RES, project: null, onBack() {} });
  await wait(30);
  assert.match(text($(box5, ".thread-view")), /It is open\./);
  // The stream's first open is not a resume, so only the comebacks are told (api.js heardResume).
  const fireOpen = () => heardResume("reconnect");
  const before = calls.length;
  // While the stream was down: a message, a queued row and an ask, and their transcript.
  res.events.push(
    { id: 11, type: "thread.sent", thread: RES, at: T0 + 3000, payload: { text: "Check the Harlow Legal invoice", surface: "deck" } },
    { id: 12, type: "thread.queued", thread: RES, at: T0 + 3500, payload: { queued: 9, uuid: "q9", text: "Then email juno", surface: "deck" } });
  res.asks = [{ id: "ask_r1", thread: RES, kind: "permission", tool: "Bash", summary: "npm test", at: T0 + 4000 }];
  res.blocks.push(
    { seq: 2, kind: "user", ts: T0 + 3000, text: "Check the Harlow Legal invoice" },
    { seq: 3, kind: "text", ts: T0 + 4000, message: "msg_r1", text: "The invoice totals match." });
  res.next = 4;
  fireOpen(); // the stream is back
  await wait(40);
  const since = calls.slice(before);
  assert.deepEqual(since.find(c => c.tool === "threads.get")?.input, { thread: RES, since: 10, limit: 500 }, "events since the last one applied");
  assert.ok(since.some(c => c.tool === "recall.transcript" && c.input.from === 2), "the transcript from next");
  assert.ok(since.some(c => c.tool === "threads.asks" && c.input.thread === RES));
  const view = () => text($(box5, ".thread-view"));
  assert.equal(view().split("Check the Harlow Legal invoice").length - 1, 1, "the missed message, once");
  assert.equal(view().split("The invoice totals match.").length - 1, 1, "its reply, once");
  assert.match(text($(box5, ".cv-queued")), /Then email juno/);
  assert.equal($$(box5, ".cv-ask").length, 1, "the missed ask");
  // Again: the same reads change nothing.
  fireOpen();
  await wait(40);
  assert.equal(view().split("Check the Harlow Legal invoice").length - 1, 1);
  assert.equal(view().split("The invoice totals match.").length - 1, 1);
  assert.equal($$(box5, ".cv-queued-row").length, 1);
  assert.equal($$(box5, ".cv-ask").length, 1);
  // The box's log was reset: ids start again at 2, below everything seen.
  res.events = [{ id: 3, type: "thread.queued", thread: RES, at: Date.now(), payload: { queued: 10, uuid: "q10", text: "And ping kit", surface: "deck" } }];
  const b2 = calls.length;
  heardResume("reset", 2);
  await wait(40);
  assert.deepEqual(calls.slice(b2).find(c => c.tool === "threads.get")?.input, { thread: RES, since: 2, limit: 500 }, "from vyred's id");
  assert.match(text($(box5, ".cv-queued")), /And ping kit/, "an event after the reset is applied, though its id is low");
  // A live event with a low id after the reset is heard too (api.js lowered its cursor).
  hear(/** @type {any} */ ({ id: 4, type: "thread.queued", thread: RES, at: Date.now(), payload: { queued: 11, uuid: "q11", text: "Last one for Northwind Bakery", surface: "deck" } }));
  await wait();
  assert.match(text($(box5, ".cv-queued")), /Last one for Northwind Bakery/);
  stop5();
});

// ---- sessions 034c71e5: background tasks, thinking, ! shell, # memory, images ---------------------

test("your server's background tasks, thinking, ! and # and pasted images, on their real shapes; an older box keeps them off", async () => {
  const { CAPS, SEND_IMAGES } = await import("./core/caps.js");
  newTasks = [{ id: "task_1", kind: "shell", title: "npm run dev", status: "running", call: null, background: true }];
  const box6 = new El("div");
  doc.body.append(box6);
  const stop6 = mountSession(box6, { thread: NEW, project: null, onBack() {} });
  await wait(30);
  assert.ok(calls.some(c => c.tool === "threads.tasks" && c.input.thread === NEW), "the tray starts from threads.tasks");
  assert.equal(CAPS.has(SEND_IMAGES), true, "its answer says images too");
  assert.match(text($(box6, ".cv-tasks")), /1 running/);
  assert.match(text($(box6, ".cv-task")), /npm run dev/);
  // thread.task: a subagent starts and finishes with a summary.
  at("thread.task", { id: "task_2", status: "running", kind: "agent", title: "Check the menu prices", call: null, background: false });
  assert.match(text($(box6, ".cv-tasks")), /2 running/);
  at("thread.task", { id: "task_2", status: "completed", summary: "Two prices were out of date." });
  assert.match(text($(box6, ".cv-tasks")), /Two prices were out of date\./);
  // Stop: threads.kill-task {thread, task}, then the box says killed.
  await $(box6, ".cv-task-stop").click();
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.kill-task").at(-1).input, { thread: NEW, task: "task_1" });
  at("thread.task", { id: "task_1", status: "killed", summary: "stopped by the user" });
  assert.match(text($(box6, ".cv-tasks")), /none running/);
  assert.match(text($(box6, ".cv-tasks")), /stopped/);

  // Thinking: the chip calls threads.thinking {thread, on}; thinking.switched moves it.
  const chip = () => $(box6, ".composer-thinking");
  assert.equal(chip().disabled, false);
  assert.equal(text(chip()), "Thinking", "not said yet");
  await chip().click();
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.thinking").at(-1).input, { thread: NEW, on: true });
  assert.equal(text(chip()), "Thinking on");
  at("thinking.switched", { on: false });
  await wait();
  assert.equal(text(chip()), "Thinking off");
  // A reasoning delta and a text delta of one message are two rows.
  at("thread.thinking", { message: "msg_th", block: 0, delta: "The total rounds twice." });
  at("thread.text", { message: "msg_th", block: 1, delta: "Found the rounding." });
  await wait(40);
  // Two rows: the thought (folded, its words in its body) and the reply.
  assert.equal($$(box6, ".cv-think").length, 1);
  assert.equal($(box6, ".cv-think-body").textContent, "The total rounds twice.");
  assert.equal($$(box6, ".cv-text").length, 1);
  at("thread.finished", { ok: true, duration_ms: 1000 });
  await wait(20);

  // ! shell: threads.shell {thread, command}; the answer's {code, output} fills the row; its event is the same row.
  const ta = $(box6, "textarea");
  const key = (k, extra = {}) => { const e = Object.assign(/** @type {any} */ (new Event("keydown")), { key: k, target: ta, ...extra }); ta.dispatchEvent(e); return e; };
  ta.value = "!npm test";
  key("Enter");
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.shell").at(-1).input, { thread: NEW, command: "npm test" });
  at("thread.shell", { command: "npm test", code: 1, output: "1 failing" });
  await wait();
  assert.equal($$(box6, ".cv-shell").length, 1, "the echo is the same row");
  assert.match(text($(box6, ".cv-shell")), /npm test/);
  assert.match(text($(box6, ".cv-shell")), /exit 1/);
  assert.match(text($(box6, ".cv-shell")), /estate intake: total/, "the answer's whole output");
  assert.equal($(box6, ".cv-shell").getAttribute("data-state"), "failed");

  // /remember memory: threads.remember {thread, text, scope}; thread.remembered is a notice.
  ta.value = "/remember Prices have two decimals.";
  key("Enter");
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.remember").at(-1).input, { thread: NEW, text: "Prices have two decimals.", scope: "project" });
  assert.match(text($(box6, ".composer-note")), /Saved to memory.*CLAUDE\.md/);
  at("thread.remembered", { scope: "project", file: "/home/alex/work/harlow-legal/CLAUDE.md" });
  await wait();
  assert.match(text($(box6, ".thread-view")), /Remembered in CLAUDE\.md \(this project\)/);

  // A pasted image goes with the words as {media_type, data}; thread.sent counts it on the message.
  /** @type {any} */ (globalThis).FileReader = class { readAsDataURL(f) { this.result = `data:${f.type};base64,${f.b64}`; setTimeout(() => this.onload?.(), 0); } };
  const png = { type: "image/png", name: "Screenshot 14:36", size: 8, b64: "iVBORw0KGgo=" };
  const paste = Object.assign(/** @type {any} */ (new Event("paste")), { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => png }] } });
  ta.dispatchEvent(paste);
  await wait(20);
  assert.equal($$(box6, ".composer-thumb").length, 1);
  ta.value = "What is wrong on this invoice?";
  key("Enter");
  await wait();
  const sent = calls.filter(c => c.tool === "threads.send").at(-1).input;
  assert.deepEqual(sent.images, [{ media_type: "image/png", data: "iVBORw0KGgo=" }]);
  assert.equal($$(box6, ".composer-thumb").length, 0);
  at("thread.sent", { text: "What is wrong on this invoice?", surface: "deck", uuid: "box-img-1", images: 1 });
  await wait();
  // The local send already drew the real picture (cohesion item 18): thread.sent's bare count
  // (the box never echoes the bytes back) must not downgrade it to a plain "1 image" line.
  const sentRow = /** @type {any} */ ($$(box6, ".cv-user").at(-1));
  assert.equal($$(sentRow, ".cv-pic").length, 1);
  assert.equal($(sentRow, ".cv-pic-img").getAttribute("src"), "data:image/png;base64,iVBORw0KGgo=");
  assert.doesNotMatch(text(sentRow), /1 image/);

  // An older box (threads.tasks: no such tool): images, !, #, thinking and Stop are off.
  at("thread.task", { id: "task_3", status: "running", kind: "shell", title: "npm run e2e", call: null, background: true });
  CAPS.set("threads.tasks", false);
  await wait();
  assert.equal(chip().disabled, true);
  assert.equal(chip().getAttribute("title"), "Needs the sessions update");
  assert.equal($(box6, ".composer-attach").hidden, true);
  assert.equal($(box6, ".cv-task-stop").disabled, true);
  const before = calls.filter(c => c.tool === "threads.shell").length;
  ta.value = "!ls";
  key("Enter");
  await wait();
  assert.equal(calls.filter(c => c.tool === "threads.shell").length, before, "never called");
  ta.value = "";
  stop6();
});

test("the composer grows with its text once a frame, and a key on a line that fits sets no height", async () => {
  const box7 = new El("div");
  doc.body.append(box7);
  const stop7 = mountSession(box7, { thread: NEW, project: null, onBack() {} });
  await wait(30);
  const ta = /** @type {any} */ ($(box7, "textarea"));
  const type = (/** @type {string} */ v) => { ta.value = v; ta.dispatchEvent(new Event("input")); };
  let reads = 0, sh = 32;
  Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => { reads++; return sh; } });
  Object.defineProperty(ta, "clientHeight", { configurable: true, get: () => Number.parseInt(ta.style.height, 10) || 32 });
  ta.style.height = "";
  for (const v of ["H", "Ha", "Har", "Harl"]) type(v);
  await wait(30);
  assert.equal(ta.style.height, "", "a line that fits sets no height");
  assert.equal(reads, 1, "four keys in one frame measure once");
  sh = 72;
  type("Harlow Legal\nNorthwind Bakery\njuno");
  await wait(30);
  assert.equal(ta.style.height, "72px", "more lines grow your server");
  sh = 400;
  type("x".repeat(2000));
  await wait(30);
  assert.equal(ta.style.height, "200px", "never past 200 px, then it scrolls");
  sh = 32;
  type("");
  await wait(30);
  assert.equal(ta.style.height, "32px", "shorter text shrinks it back");
  stop7();
});

test("reopened while an Edit waits on Allow: the pending steer and the queued row come back from threads.get; the state word is asking", async () => {
  const box5 = new El("div");
  doc.body.append(box5);
  const stop5 = mountSession(box5, { thread: REOPEN, project: null, onBack() {} });
  await wait(30);
  assert.match(text($(box5, ".cv-state")), /^asking$/, "an open ask: canonical_status (sessions' 6e2f8a71) says asking, not the swapped legacy waiting");
  assert.ok($(box5, ".cv-ask"), "the ask is still there");
  // The steer: its words and a "Steering" marker, since Claude has not taken them in yet.
  const steers = $$(box5, ".cv-steer");
  assert.equal(steers.length, 2, "the old steer (taken in) and the new one (pending)");
  assert.match(text(steers.at(-1)).trim(), /^steering · \w+ reads it at its next step$/);
  assert.match(text($$(box5, ".cv-user").at(-1)), /use the rye price too/);
  assert.equal($$(box5, ".cv-user").filter(u => /read the menu first/.test(text(u))).length, 1, "the taken-in steer is the transcript's, once");
  // The queue: the row still waiting, not the one taken back.
  assert.equal($(box5, ".cv-queued").hidden, false);
  const rows = $$(box5, ".cv-queued-row");
  assert.equal(rows.length, 1);
  assert.match(text(rows[0]), /then check the hours/);
  assert.equal($(rows[0], ".cv-q-edit").disabled, false, "the row has its id (5)");
  // The answer, then Claude takes the steer in and hands the queued words over: each once.
  const ev = (type, payload) => emit(type, payload, REOPEN);
  ev("ask.answered", { ask: "ask_e", decision: "allow", by: "deck" });
  ev("thread.steered", { uuid: "s-new", step: 1 });
  assert.match(text($$(box5, ".cv-steer").at(-1)).trim(), /^you steered here · after 1 step/);
  ev("thread.finished", { ok: true });
  ev("thread.sent", { text: "then check the hours", surface: "deck", queued: 5, uuid: "q-new", via: "turn" });
  assert.equal($(box5, ".cv-queued").hidden, true);
  assert.equal($$(box5, ".cv-user").filter(u => /use the rye price too/.test(text(u))).length, 1);
  assert.equal($$(box5, ".cv-user").filter(u => /then check the hours/.test(text(u))).length, 1);
  stop5();
});

test("sight.frame stills (cohesion item 1/18): kit's own live target draws a still, refreshed on sight.stepped, and only its own agent", async () => {
  const frames = [];
  sightWorld = {
    targets: [{ target: "agent:kit", kind: "agent", label: "kit", live: true }, { target: "agent:juno", kind: "agent", label: "juno", live: true }],
    frame: input => { frames.push(input); return { target: input.target, image: `frame${frames.length}`, mime: "image/png", maxWidth: input.maxWidth, at: Date.now(), step: frames.length }; },
  };
  const box8 = new El("div");
  doc.body.append(box8);
  const stop8 = mountSession(box8, { thread: NEW, project: null, onBack() {} });
  await wait(30);
  assert.deepEqual(frames.map(f => f.target), ["agent:kit"], "kit's own target, never juno's - the registry says who is live, not a guess");
  assert.equal($(box8, ".cv-sight").hidden, false);
  assert.equal($(box8, ".cv-sight .cv-pic-img").getAttribute("src"), "data:image/png;base64,frame1");
  // sight.stepped for a DIFFERENT target or thread: no refresh (still frame1).
  emit("sight.stepped", { target: "agent:juno", thread: NEW }, NEW);
  hear(/** @type {any} */ ({ id: ++evId, type: "sight.stepped", thread: "some-other-thread", at: Date.now(), payload: { target: "agent:kit" } }));
  await wait();
  assert.equal(frames.length, 1, "neither one refreshed it");
  // sight.stepped for this thread and this target: a fresh still.
  emit("sight.stepped", { target: "agent:kit" }, NEW);
  await wait();
  assert.equal(frames.length, 2);
  assert.equal($(box8, ".cv-sight .cv-pic-img").getAttribute("src"), "data:image/png;base64,frame2");
  stop8();
  sightWorld = null;
});

test("sight.frame stills: no agent, or the agent has no live computer, draws nothing", async () => {
  sightWorld = { targets: [], frame: () => { throw new Error("must not be called"); } };
  const box9 = new El("div");
  doc.body.append(box9);
  // RES has no agent at all.
  const stop9 = mountSession(box9, { thread: RES, project: null, onBack() {} });
  await wait(30);
  assert.equal($(box9, ".cv-sight").hidden, true);
  stop9();
  sightWorld = null;
});

test("sight.frame stills: a computer that goes live after the thread opens still gets the strip (reviewer's LOW on 18980d2d), matched by target not label", async (t) => {
  const frames = [];
  // No live target yet at mount, and kit's row uses a display label that differs from its id -
  // matching by target (the registry's own identifier) rather than label is what finds it at all.
  sightWorld = { targets: [{ target: "agent:kit", kind: "agent", label: "Kit (renamed)", live: false }], frame: () => { throw new Error("must not be called yet"); } };
  const box10 = new El("div");
  doc.body.append(box10);
  const stop10 = mountSession(box10, { thread: NEW, project: null, onBack() {} });
  // t.after runs even if an assertion throws mid-test (team-lead, the hang investigation): a
  // leaked composer timer (leaseTimer et al.) otherwise outlives the test, since a thrown
  // assertion skips every line after it, including a plain stopN() at the end.
  t.after(() => { stop10(); sightWorld = null; });
  await wait(30);
  assert.equal($(box10, ".cv-sight").hidden, true, "not live yet: nothing drawn");
  // The computer goes live for this thread: sight.targets is asked again, without a reopen.
  sightWorld = {
    targets: [{ target: "agent:kit", kind: "agent", label: "Kit (renamed)", live: true }],
    frame: input => { frames.push(input); return { target: input.target, image: `frame${frames.length}`, mime: "image/png", maxWidth: input.maxWidth, at: Date.now(), step: frames.length }; },
  };
  emit("computer.checked-out", { agent: "kit", thread: NEW }, NEW);
  await wait(30);
  assert.deepEqual(frames.map(f => f.target), ["agent:kit"]);
  assert.equal($(box10, ".cv-sight").hidden, false);
  assert.equal($(box10, ".cv-sight .cv-pic-img").getAttribute("src"), "data:image/png;base64,frame1");
  // A second checked-out for a different thread does nothing more (still just the one lookup+frame).
  emit("computer.checked-out", { agent: "kit", thread: "some-other-thread" }, "some-other-thread");
  await wait();
  assert.equal(frames.length, 1);
});

test("a teammate handoff (team_ask): its own card, the teammate's tile+name+Teammate tag, 'Asked' then 'Replied' once the result lands (teammates.md section 3)", async (t) => {
  const box11 = new El("div");
  doc.body.append(box11);
  const stop11 = mountSession(box11, { thread: NEW, project: null, onBack() {} });
  t.after(stop11); // even if an assertion below throws (team-lead's hang investigation)
  await wait(30);
  emit("thread.tool", { id: "tu_h1", tool: "team_ask", phase: "started", input: { to: "design", text: "make the intake form calmer" } }, NEW);
  await wait();
  const row = $(box11, ".cv-handoff");
  assert.ok(row, "its own row, not a generic tool card");
  assert.match(text($(row, ".cv-handoff-name")), /^design$/);
  assert.match(text($(row, ".cv-handoff-tag")), /^Teammate$/);
  assert.equal($(row, ".av-agent").getAttribute("data-family"), "teammate", "the teammate's character (ADR 0043), not an agent's blob");
  assert.match(text($(row, ".cv-tool-name")), /^Asked\s*$/);
  assert.match(text($(row, ".cv-handoff-sum")), /make the intake form calmer/);
  assert.ok($(row, ".av-agent"), "the teammate's own tile, not a generic sub-agent icon");
  assert.equal($(row, ".cv-handoff-head").disabled, true, "nothing to open yet");
  // The reply lands as thread.sent {kind: teammate-result}, never a message of its own.
  emit("thread.sent", { text: "Warmed up the copy in three places.", surface: "design", kind: "teammate-result", uuid: "post-h1" }, NEW);
  await wait();
  assert.match(text($(row, ".cv-tool-name")), /^Replied\s*$/);
  assert.equal($$(box11, ".cv-user").length, 0, "still no ordinary message for it");
  assert.equal($(row, ".cv-handoff-head").disabled, false, "now openable");
  await $(row, ".cv-handoff-head").click();
  assert.ok(row.hasAttribute("data-open"));
  assert.match(text($(row, ".cv-handoff-reply")), /Warmed up the copy in three places/);
});

test("@role: an existing teammate's own turn, never this session's; an unknown role is made at once with no confirm; a near miss offers @design; teammates off points at Settings (native-core.md section 9)", async (t) => {
  const box12 = new El("div");
  doc.body.append(box12);
  const stop12 = mountSession(box12, { thread: NEW, project: null, onBack() {} });
  t.after(stop12);
  await wait(30);
  const ta = /** @type {any} */ ($(box12, "textarea"));
  const key = (k) => { const e = Object.assign(/** @type {any} */ (new Event("keydown")), { key: k, target: ta }); ta.dispatchEvent(e); return e; };

  // An existing teammate: team.ask goes, never threads.send - this is not the session's own turn.
  teamWorld = { hasTeammate: true, defaultOn: true, adds: [] };
  const sendsBefore = calls.filter(c => c.tool === "threads.send").length;
  ta.value = "@design make the intake form calmer";
  key("Enter");
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "team.ask").at(-1).input, { to: "design", text: "make the intake form calmer", surface: "deck" });
  assert.equal(calls.filter(c => c.tool === "threads.send").length, sendsBefore, "never this session's turn");
  assert.equal(ta.value, "", "cleared on a plain success");

  // No "research" teammate yet, teammates on: made at once and asked, with no confirm card in between.
  teamWorld = { hasTeammate: false, defaultOn: true, adds: [] };
  ta.value = "@research find comparable filing fees";
  key("Enter");
  await wait();
  assert.equal($$(box12, ".composer-note button").filter(b => /Create and send|Don't create/.test(text(b))).length, 0, "no confirm card");
  assert.deepEqual(calls.filter(c => c.tool === "team.add").at(-1).input,
    { project: "harlow-legal", role: "research", brief: "Ask me about anything; I'll figure out the role from what you send me.", isolation: "folder", tools: ["files", "web"], model: "sonnet" });
  assert.deepEqual(calls.filter(c => c.tool === "team.ask").at(-1).input, { to: "research", text: "find comparable filing fees", surface: "deck" });
  assert.equal(ta.value, "", "sent");

  // A near miss of a role this project has: one chip while typing, Tab takes it, and sending as typed still creates the new role.
  teamWorld = { hasTeammate: true, defaultOn: true, adds: [] };
  ta.value = "@desgin";
  ta.dispatchEvent(new Event("input"));
  await wait(400);
  const chip = /** @type {any} */ ($$(box12, ".composer-note button").find(b => /@design/.test(text(b))));
  assert.ok(chip, "Did you mean @design?");
  assert.match(text($(box12, ".composer-note")), /Did you mean\s+@design\s*\?/);
  const tab = key("Tab");
  assert.equal(tab.defaultPrevented, true);
  assert.equal(ta.value, "@design ", "Tab took the near role");

  // The person's own agent by that name, when no role has it: agents.ask, not a new teammate.
  teamWorld = { hasTeammate: false, defaultOn: true, adds: [] };
  const addsBeforeA = calls.filter(c => c.tool === "team.add").length;
  ta.value = "@kit what did we decide on the renewal wording";
  key("Enter");
  await wait();
  assert.deepEqual(calls.filter(c => c.tool === "agents.ask").at(-1).input, { agent: "kit", text: "what did we decide on the renewal wording", surface: "deck", wait: false });
  assert.equal(calls.filter(c => c.tool === "team.add").length, addsBeforeA, "an agent is not a new teammate");
  assert.match(text($(box12, ".composer-note")), /Sent to kit\.\s+Open kit's chat/);

  // team.default off: no create, and the note points at that project's Settings, in words.
  teamWorld = { hasTeammate: false, defaultOn: false, adds: [] };
  const teamAsksBefore = calls.filter(c => c.tool === "team.ask").length;
  const sendsBefore3 = calls.filter(c => c.tool === "threads.send").length;
  const addsBefore3 = calls.filter(c => c.tool === "team.add").length;
  ta.value = "@legal check the filing deadline";
  key("Enter");
  await wait();
  assert.match(text($(box12, ".composer-note")), /Teammates are off for this project, so there's no legal here\.\s+Turn them on in Settings/);
  assert.equal(calls.filter(c => c.tool === "team.add").length, addsBefore3);
  assert.equal(calls.filter(c => c.tool === "threads.send").length, sendsBefore3, "nothing sent");
  assert.equal(calls.filter(c => c.tool === "team.ask").length, teamAsksBefore + 1, "still tried the ask itself - only creation is gated on team.default");
  teamWorld = null;
});

test("a server thread opens from its own history when no Mac is paired, and recall is asked once, not on every read (#56)", async () => {
  const box = new El("div");
  doc.body.append(box);
  const before = calls.length;
  const stopN = mountSession(box, { thread: NOREC, project: null, onBack() {} });
  await wait(30);
  assert.match(text(box), /hello from the server/, "the thread's events drew it");
  assert.equal(calls.slice(before).filter(c => c.tool === "recall.transcript").length, 1, "one failed ask, then none");
  assert.equal(calls.slice(before).filter(c => c.tool === "recall.thread").length, 0, "recall.thread is for a Mac's sessions");
  stopN();
});
