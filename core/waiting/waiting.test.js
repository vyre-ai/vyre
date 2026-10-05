// @ts-check
// The waiting module against fake threads, gate and planner modules in a temp home. The fakes
// answer with the owners' real shapes (core/switchboard/asks.js shape, core/gate/gate.js brief,
// core/planner/index.js planner.ringing).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { clean, tally } from "./index.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const wait = ms => new Promise(r => setTimeout(r, ms));
const T = 1_790_000_000_000;

const ASK_Q = { id: "a1", thread: "t-harlow", tool: "AskUserQuestion", summary: "Which palette should the Northwind Bakery menu use?", destination: null, reason: null,
  at: T + 1000, state: "open", decision: null, kind: "question", questions: [{ question: "Which palette should the Northwind Bakery menu use?", options: [] }],
  agent: "kit", thread_name: "Menu redesign", anchor: { tool_use_id: "tu1", event: 4 }, always: false, always_project: null, presence: { required: false, covered: false, since: null } };
const ASK_P = { id: "a2", thread: "t-harlow", tool: "Bash", summary: "Bash npm test", destination: null, reason: null, at: T + 4000, state: "open", decision: null,
  kind: "permission", agent: null, thread_name: null, anchor: { tool_use_id: null, event: null }, always: true, always_project: null, presence: { required: false, covered: false, since: null } };
const HELD = { id: "g1", kind: "send", via: "mail", to: ["dana@harlowlegal.com"], summary: "Re: the Harlow Legal retainer", why: "the client asked for it",
  agent: "juno", thread: "t-harlow", project: "harlow-legal", at: T + 3000, anchor: { tool_use_id: null, event: 9, thread: "t-harlow", at: T + 3000 },
  presence: { required: true, covered: false, since: null } };
const RING = { firing: "f1", key: `planner-i1-${Math.floor((T + 2000) / 1000)}`, item: "i1", kind: "reminder", title: "Call alex about the bakery lease", due: T + 2000, ring: 1, missed: false, actions: ["done", "snooze"] };

const fake = (name, tool, key, extra = "") => [name, [tool],
  `export default { async start(ctx) { ctx.tool(${JSON.stringify(tool)}, { effect: "read", ${extra} run: async () => { globalThis.calls[${JSON.stringify(tool)}] = (globalThis.calls[${JSON.stringify(tool)}] || 0) + 1;
    const v = globalThis.fake[${JSON.stringify(key)}]; if (v instanceof Error) throw v; return v; } }); return {}; } };`];
const ALL = [fake("threads", "threads.asks", "asks"), fake("gate", "gate.held", "held"), fake("planner", "planner.ringing", "ringing")];

async function world(t, fakes = ALL, data = {}, role = "box") {
  /** @type {any} */ (globalThis).fake = { asks: [], held: [], ringing: [], ...data };
  /** @type {any} */ (globalThis).calls = {};
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, tools, src] of fakes) writeModule(root, name, { roles: ["box", "local"], does: { tools }, watches: { emits: [] } }, src);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const said = [];
  events.on("waiting.changed", e => said.push(e.payload));
  const reg = new Registry({ db, events, config: { role }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "waiting");
  await reg.start([...core, ...discover([root])], { role });
  t.after(async () => { await reg.stop?.(); db.close(); });
  const call = async (tool, input = {}, caller = "cli") => (await reg.call(tool, input, caller));
  return { reg, events, said, call, calls: /** @type {any} */ (globalThis).calls, data: /** @type {any} */ (globalThis).fake };
}

test("waiting.list: the three sources in one list, newest first, with source-prefixed ids and a tally", async t => {
  const w = await world(t, ALL, { asks: [ASK_Q, ASK_P], held: [HELD], ringing: [RING] });
  const r = (await w.call("waiting.list")).data;
  assert.deepEqual(r.rows.map(x => x.id), ["threads:a2", "gate:g1", "planner:f1", "threads:a1"]);
  assert.deepEqual(r.rows.map(x => x.kind), ["ask", "draft", "reminder", "ask"]);
  assert.equal(r.count, 4);
  assert.deepEqual(r.by_kind, { ask: 2, draft: 1, reminder: 1 });
  assert.equal(r.partial, undefined);
  assert.deepEqual(r.rows.find(x => x.id === "gate:g1"), { id: "gate:g1", kind: "draft", title: "Re: the Harlow Legal retainer", detail: "mail to dana@harlowlegal.com",
    project: "harlow-legal", thread: "t-harlow", at: T + 3000, source: "gate", answer: { tool: "gate.approve", input: { id: "g1" }, fill: [] } });
  assert.ok(!JSON.stringify(r).includes("the client asked"), "nothing from the draft beyond the summary");
  assert.deepEqual((await w.call("waiting.count")).data, { count: 4, by_kind: { ask: 2, draft: 1, reminder: 1 } });
  for (const who of ["deck", "capsule", "local", "module:push"]) assert.ok((await w.call("waiting.list", {}, who)).data, who);
  assert.equal((await w.call("waiting.list", {}, "mcp")).error.code, "denied", "a model does not read the queue");
});

test("waiting.list: each kind says which owner tool answers it and what the person still gives", async t => {
  const w = await world(t, ALL, { asks: [ASK_Q, ASK_P], held: [HELD], ringing: [RING] });
  const by = Object.fromEntries((await w.call("waiting.list")).data.rows.map(x => [x.id, x]));
  assert.deepEqual(by["threads:a1"].answer, { tool: "threads.answer", input: { ask: "a1" }, fill: ["decision", "answers"] });
  assert.deepEqual(by["threads:a2"].answer, { tool: "threads.answer", input: { ask: "a2" }, fill: ["decision"] });
  assert.deepEqual(by["planner:f1"].answer, { tool: "planner.done", input: { firing: "f1" }, fill: [] });
  assert.equal(by["threads:a1"].title, "Which palette should the Northwind Bakery menu use?");
  assert.equal(by["threads:a1"].detail, "kit in Menu redesign");
  assert.equal(by["threads:a1"].thread, "t-harlow");
  assert.equal(by["planner:f1"].title, "Call alex about the bakery lease");
  assert.equal(by["planner:f1"].at, T + 2000, "a ring is dated by when it was due");
});

test("waiting.list: a failing, refused or missing source leaves its name in partial and the rest still show", async t => {
  const w = await world(t, [fake("threads", "threads.asks", "asks"), fake("gate", "gate.held", "held"), fake("planner", "planner.ringing", "ringing", `callers: ["cli"],`)],
    { asks: [ASK_P], held: new Error("gate broke"), ringing: [RING] });
  const r = (await w.call("waiting.list")).data;
  assert.deepEqual(r.rows.map(x => x.id), ["threads:a2"]);
  assert.deepEqual(r.partial, ["gate", "planner"], "threw, refused module callers");
  assert.deepEqual(r.by_kind, { ask: 1, draft: 0, reminder: 0 });
});

test("waiting.list: limit cuts the rows, never the count", async t => {
  const w = await world(t, ALL, { asks: [ASK_Q, ASK_P], held: [HELD], ringing: [RING] });
  const r = (await w.call("waiting.list", { limit: 2 })).data;
  assert.deepEqual(r.rows.map(x => x.id), ["threads:a2", "gate:g1"]);
  assert.equal(r.count, 4);
});

test("titles: an owner's summary shaped like a credential is dropped whole, not shown", async t => {
  assert.equal(clean("Bash curl -H 'Authorization: Bearer " + "q".repeat(40) + "'"), "");
  assert.equal(clean("export API_KEY=" + "x".repeat(10)), "");
  assert.equal(clean("  Bash   npm test "), "Bash npm test");
  assert.equal(clean("a ".repeat(200)).length, 120);
  assert.deepEqual(tally([{ kind: "ask" }, { kind: "ask" }]), { count: 2, by_kind: { ask: 2, draft: 0, reminder: 0 } });
  const leaky = { ...ASK_P, summary: "Bash deploy --token " + "sk-" + "z".repeat(30) };
  const w = await world(t, ALL, { asks: [leaky] });
  const [row] = (await w.call("waiting.list")).data.rows;
  assert.equal(row.title, "Allow Bash?");
});

test("waiting.changed: after the owners' events, coalesced, and only when the count or the kinds move", async t => {
  const w = await world(t, ALL, { asks: [ASK_P] });
  await wait(450);                                              // the first computation at start
  assert.deepEqual(w.said, [{ count: 1, by_kind: { ask: 1, draft: 0, reminder: 0 } }]);
  const before = w.calls["threads.asks"];

  // A burst of events is one computation.
  w.data.held = [HELD];
  for (let i = 0; i < 5; i++) w.events.emit("gate", "gate.held", { id: `g${i}` });
  w.events.emit("switchboard", "ask.raised", { ask: "a9" });
  await wait(150);
  assert.equal(w.calls["threads.asks"], before, "nothing before the debounce");
  await wait(300);
  assert.equal(w.calls["threads.asks"], before + 1, "one computation for six events");
  assert.deepEqual(w.said.at(-1), { count: 2, by_kind: { ask: 1, draft: 1, reminder: 0 } });
  assert.equal(w.said.length, 2);

  // waiting.count after the event reads the cache, with no call to any owner.
  assert.deepEqual((await w.call("waiting.count")).data, { count: 2, by_kind: { ask: 1, draft: 1, reminder: 0 } });
  assert.equal(w.calls["threads.asks"], before + 1);

  // An event that changes nothing recomputes but says nothing.
  w.events.emit("gate", "gate.revised", { id: "g1" });
  await wait(450);
  assert.equal(w.calls["threads.asks"], before + 2);
  assert.equal(w.said.length, 2);

  // The same count with the kinds swapped is a change.
  w.data.held = [];
  w.data.ringing = [RING];
  w.events.emit("planner", "planner.fired", { firing: "f1" });
  await wait(450);
  assert.deepEqual(w.said.at(-1), { count: 2, by_kind: { ask: 1, draft: 0, reminder: 1 } });

  // Events that never change what waits do not recompute at all.
  const n = w.calls["threads.asks"];
  w.events.emit("planner", "planner.added", { item: "i2" });
  w.events.emit("switchboard", "thread.text", { text: "hi" });
  await wait(450);
  assert.equal(w.calls["threads.asks"], n);

  assert.equal(w.said.length, 3);
});

test("fromAsks: an ask from a session on the paired Mac names its machine and is answered there", async () => {
  const { fromAsks } = await import("./index.js");
  const [mac, box] = fromAsks([
    { id: "a1", kind: "permission", tool: "Bash", summary: "npm test", source: "mac", machine: "alex-mbp", at: 2 },
    { id: "a2", kind: "permission", tool: "Bash", summary: "ls", at: 1 },
  ]);
  assert.equal(mac.machine, "alex-mbp");
  assert.deepEqual(mac.answer, { tool: null, input: null, fill: [], on: "alex-mbp" }, "answered on the Mac until federation lands");
  assert.equal(fromAsks([{ id: "a3", kind: "question", source: "mac", at: 3 }])[0].answer.on, "your Mac");
  assert.equal(box.machine, undefined);
  assert.deepEqual(box.answer.input, { ask: "a2" });
});

test("waiting.list on a Mac leaves out the planner, which is the box's over the link", async t => {
  const w = await world(t, ALL, { ringing: [RING] }, "local");
  const r = (await w.call("waiting.list")).data;
  assert.ok(!r.rows.some(x => x.source === "planner"));
  assert.equal(w.calls["planner.ringing"] || 0, 0, "a Mac's vyred never asks the box's planner on its own");
});
