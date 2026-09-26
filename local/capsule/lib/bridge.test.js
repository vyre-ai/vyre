// @ts-check
// The bridge against a real vyred in a temp home, seeded with the fictional corpus. The
// switchboard and the Gate are faked at the client, not as modules, so these tests keep passing
// when the real ones merge and register the same tool names.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../../test/helpers.js";
import { seedRecall } from "../../../test/fixtures/corpus.js";
import { open } from "../../../core/store/index.js";
import { start } from "../../../core/daemon/index.js";
import { paths } from "../../../core/config/index.js";
import { client, stream } from "./vyred.js";
import { Bridge, explain } from "./bridge.js";

/** `bare` turns the core switchboard (`threads`) and `agents` off, for the tests about their absence. */
async function vyred(t, { bare = false } = {}) {
  const root = tempHome(t);
  const tx = path.join(root, "transcripts");
  fs.mkdirSync(tx);
  const modules = bare ? { modules: { enable: [], disable: ["threads", "agents"] } } : {};
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [tx], projectsDir: path.join(root, "projects"), roots: [], ...modules }));
  const db = open(paths(root).db);
  seedRecall(db, undefined, { transcripts: tx });
  db.close();
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = client(d.paths.socket);
  const home = path.join(root, "work", "harlow");
  fs.mkdirSync(home, { recursive: true });
  const made = await c.call("projects.create", { name: "Harlow Legal", home, threads: ["11111111-aaaa-4000-8000-000000000001"], people: [{ name: "Dana Reyes", email: "dana@harlowlegal.com" }] });
  assert.ok(made.data, JSON.stringify(made.error));
  return { d, c, home };
}

/** The real client, with the switchboard and Gate answered by `fakes`. */
function withFakes(c, fakes) {
  const calls = [];
  return {
    calls,
    get: async (r, o) => {
      const res = await c.get(r, o);
      if (r === "/v1/tools" && res.data) return { data: [...res.data, ...Object.keys(fakes).map(name => ({ name }))] };
      return res;
    },
    call: async (tool, input = {}, o) => {
      if (fakes[tool]) { calls.push([tool, input]); return { data: await fakes[tool](input) }; }
      return c.call(tool, input, o);
    },
  };
}

test("bridge: @ completes projects and threads from a running vyred", async t => {
  const { c } = await vyred(t, { bare: true });
  const b = new Bridge(c);
  assert.deepEqual(await b.refresh(), { up: true });
  assert.equal(b.catalog.agents, null, "no switchboard: no agents, and nothing pretends otherwise");
  assert.deepEqual(b.complete("harl").map(x => [x.kind, x.label]).slice(0, 1), [["project", "Harlow Legal"]]);
  const site = b.complete("site")[0];
  assert.equal(site.kind, "thread");
  assert.equal(site.label, "Harlow site rebuild");
  assert.match(site.sub, /^Harlow Legal/, "a thread in a project is named by its project");
  assert.ok(b.complete("northwind").some(x => x.label === "Northwind invoices"), "threads outside projects too");
});

test("bridge: memory answers with its sources, and no model", async t => {
  const { c } = await vyred(t);
  // The curator runs in the background after start; a test cannot wait on a timer.
  await c.call("memory.curate");
  const b = new Bridge(c);
  await b.refresh();
  const r = await b.recall("what is Dana's email?");
  assert.match(String(r.answer), /dana@harlowlegal\.com/);
  assert.ok(r.sources.length >= 1);
  assert.equal(typeof r.ms, "number");
});

test("bridge: without the switchboard it says so before Enter, and sending explains why not", async t => {
  const { c } = await vyred(t, { bare: true });
  const b = new Bridge(c);
  await b.refresh();
  const none = await b.destinations(null, "what is left this week");
  assert.equal(none.options[0].kind, "recall");
  const site = b.complete("site")[0];
  const d = await b.destinations(site, "ship it");
  assert.match(String(d.unavailable), /switchboard/);
  const sent = await b.send(d.options[0], "ship it");
  assert.match(String(sent.error), /switchboard/);
});

test("bridge: with the switchboard, the assistant is the default and a reply streams back", async t => {
  const { c } = await vyred(t);
  const fc = withFakes(c, {
    "agents.list": () => [{ name: "juno", kind: "assistant" }, { name: "kit", kind: "agent" }],
    "agents.threads": () => [{ id: "t-q3", label: "Q3 report", last: Date.now() - 4 * 86_400_000, project: "harlow-legal", projectName: "Harlow Legal" }],
    "agents.ask": ({ agent }) => ({ thread: `t-${agent}` }),
    "threads.send": () => ({ ok: true }),
    "threads.lease": () => ({ holder: "capsule" }),
  });
  const b = new Bridge(fc);
  await b.refresh();
  const d = await b.destinations(null, "what is left this week");
  assert.deepEqual([d.options[0].kind, d.options[0].agent, d.unavailable], ["assistant", "juno", null]);
  assert.deepEqual(await b.send(d.options[0], "what is left this week"), { thread: "t-juno" });
  assert.deepEqual(fc.calls.at(-1), ["agents.ask", { agent: "juno", text: "what is left this week" }]);
  b.onEvent({ id: 1, at: 1, type: "thread.text", thread: "t-juno", payload: { message: "m", text: "Two things", done: false } });
  b.onEvent({ id: 2, at: 2, type: "thread.finished", thread: "t-juno", payload: { ok: true } });
  const snap = b.snapshot();
  assert.equal(snap.reply?.text, "Two things");
  assert.equal(snap.reply?.finished, true);
  assert.equal(snap.assistant, "juno");

  const kit = b.complete("kit")[0];
  const k = await b.destinations(kit, "the Harlow deck needs the Q3 report numbers");
  assert.equal(k.options[0].thread, "t-q3", "kit's words matched its Q3 report thread");
  await b.send(k.options[0], "numbers please");
  assert.deepEqual(fc.calls.slice(-2).map(x => x[0]), ["threads.lease", "threads.send"], "the lease is taken before typing into a thread");
});

test("bridge: another surface holding the keyboard stops the send and says who", async t => {
  const { c } = await vyred(t);
  const fc = withFakes(c, { "threads.lease": () => ({ holder: "terminal" }), "threads.send": () => ({ ok: true }) });
  const b = new Bridge(fc);
  await b.refresh();
  const site = b.complete("site")[0];
  const d = await b.destinations(site, "x");
  const r = await b.send(d.options[0], "x");
  assert.match(String(r.error), /terminal has the keyboard/);
  assert.ok(!fc.calls.some(x => x[0] === "threads.send"));
});

test("bridge: held items and open asks wait in one list, and answering goes through the tools", async t => {
  const { c } = await vyred(t);
  let held = [{ id: "g1", agent: "juno", to: "Dana Reyes <dana@harlowlegal.com>", subject: "Re: Q3 report", body: "Hi Dana", rule: "email to a client waits for you", at: 2000 }];
  const fc = withFakes(c, {
    "gate.held": () => held,
    "gate.approve": ({ id }) => { held = held.filter(h => h.id !== id); return { sent: true }; },
    "gate.reject": () => ({ ok: true }),
    "threads.asks": () => [{ ask: "a1", agent: "pax", summary: "email 14 clients the new intake form", at: 1000 }],
    "threads.answer": () => ({ ok: true }),
  });
  const b = new Bridge(fc);
  await b.refresh();
  assert.deepEqual(b.snapshot().waiting.map(w => w.id), ["a1", "g1"]);
  assert.deepEqual(await b.answer(b.waiting[1], "send", "Hi Dana, edited"), { ok: true });
  assert.deepEqual(fc.calls.find(x => x[0] === "gate.approve"), ["gate.approve", { id: "g1", text: "Hi Dana, edited" }]);
  assert.deepEqual(b.waiting.map(w => w.id), ["a1"], "re-read from the Gate, not removed on optimism");
  await b.answer(b.waiting[0], "allow");
  assert.deepEqual(fc.calls.at(-1)?.[0] === "threads.asks" ? fc.calls.find(x => x[0] === "threads.answer") : fc.calls.at(-1), ["threads.answer", { ask: "a1", decision: "allow" }]);
});

test("bridge: without threads.asks, open asks come from the event log", async t => {
  const { d, c } = await vyred(t, { bare: true });
  // Stand in for the switchboard's events; the bus is the same one it will emit on.
  d.events.emit("switchboard", "ask.raised", { ask: "a7", summary: "delete 214 files" }, { thread: "t1" });
  d.events.emit("switchboard", "ask.raised", { ask: "a8", summary: "push to main" }, { thread: "t1" });
  d.events.emit("switchboard", "ask.answered", { ask: "a7" }, { thread: "t1" });
  const b = new Bridge(c);
  await b.refresh();
  assert.deepEqual(b.waiting.map(w => w.id), ["a8"]);
});

test("bridge: the stream follows from now, and an event arriving later is folded in", async t => {
  const { d, c } = await vyred(t);
  const b = new Bridge(c);
  await b.refresh();
  const last = (await c.get("/v1/health")).data.last_event;
  const got = [];
  const s = stream(c.socket, { since: last, onEvent: e => { got.push(e.type); b.onEvent(e); } });
  t.after(() => s.stop());
  let stale = 0;
  b.on("stale", () => stale++);
  await new Promise(r => setTimeout(r, 100));
  d.events.emit("switchboard", "ask.raised", { ask: "a9", summary: "send the invoice" });
  await c.call("projects.create", { name: "Northwind Bakery", home: path.join(d.paths.root, "work", "northwind") });
  for (let i = 0; i < 40 && !got.includes("project.created"); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(!got.includes("system.started"), "nothing from before the Capsule opened is replayed");
  assert.ok(got.includes("ask.raised"));
  assert.deepEqual(b.waiting.map(w => w.id), ["a9"]);
  assert.ok(stale >= 1, "a new project makes the @ list stale");
});

test("bridge: when vyred is down everything is cleared, and the reason is words", async t => {
  const { d, c } = await vyred(t);
  const b = new Bridge(c);
  await b.refresh();
  await d.stop();
  const r = await b.refresh();
  assert.equal(r.up, false);
  assert.match(String(r.why), /vyre up/);
  assert.deepEqual(b.snapshot().waiting, []);
  assert.equal(b.complete("har").length, 0, "nothing stale is offered as if it were live");
  assert.match(explain({ code: "no_such_tool", message: "no tool gate.held" }), /Gate/);
});
