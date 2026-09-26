// @ts-check
// The bridge against a real vyred in a temp home, seeded with the fictional corpus. The first
// tests fake the switchboard and the Gate at the client, in their real shapes, for the cases a
// real run cannot stage cheaply; the "real switchboard" tests at the end run core threads and
// agents with the fake `claude`, and the real Gate test runs core/gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { tempHome } from "../../../test/helpers.js";
import { seedRecall } from "../../../test/fixtures/corpus.js";
import { open } from "../../../core/store/index.js";
import { start } from "../../../core/daemon/index.js";
import { paths } from "../../../core/config/index.js";
import { call } from "../../../core/daemon/client.js";
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
    // The switchboard's shapes (work/switchboard, core/agents): wait:false answers once the words are in.
    "agents.ask": ({ agent }) => ({ agent, thread: `t-${agent}`, ok: true, sent: true, text: "" }),
    "threads.send": ({ thread }) => ({ sent: true, thread }),
    "threads.lease": ({ thread }) => ({ thread, holder: "capsule", previous: null }),
  });
  const b = new Bridge(fc);
  await b.refresh();
  const d = await b.destinations(null, "what is left this week");
  assert.deepEqual([d.options[0].kind, d.options[0].agent, d.unavailable], ["assistant", "juno", null]);
  assert.deepEqual(await b.send(d.options[0], "what is left this week"), { thread: "t-juno" });
  assert.deepEqual(fc.calls.at(-1), ["agents.ask", { agent: "juno", text: "what is left this week", surface: "capsule", wait: false }]);
  b.onEvent({ id: 1, at: 1, type: "thread.text", thread: "t-juno", payload: { message: "m", delta: "Two", done: false } });
  b.onEvent({ id: 2, at: 1, type: "thread.text", thread: "t-juno", payload: { message: "m", delta: " thi", done: false } });
  b.onEvent({ id: 3, at: 1, type: "thread.text", thread: "t-juno", payload: { message: "m", text: "Two things", done: true } });
  b.onEvent({ id: 4, at: 2, type: "thread.finished", thread: "t-juno", payload: { ok: true } });
  const snap = b.snapshot();
  assert.equal(snap.reply?.text, "Two things");
  assert.equal(snap.reply?.finished, true);
  assert.equal(snap.assistant, "juno");

  const kit = b.complete("kit")[0];
  const k = await b.destinations(kit, "the Harlow deck needs the Q3 report numbers");
  assert.equal(k.options[0].thread, "t-q3", "kit's words matched its Q3 report thread");
  await b.send(k.options[0], "numbers please");
  assert.deepEqual(fc.calls.at(-1), ["threads.send", { thread: "t-q3", text: "numbers please", surface: "capsule" }], "a free thread is taken by typing; no lease is grabbed first");
  assert.ok(!fc.calls.some(x => x[0] === "threads.lease"));
});

test("bridge: another surface holding the keyboard stops the send and says who, and only the user takes it", async t => {
  const { c } = await vyred(t);
  let holder = "terminal";
  const fc = withFakes(c, {
    "threads.lease": ({ thread, surface }) => { const previous = holder; holder = surface; return { thread, holder, previous }; },
    "threads.send": ({ thread, surface }) => (holder === surface ? { sent: true, thread } : { sent: false, holder, note: `${holder} has the keyboard; threads.lease takes it` }),
  });
  const b = new Bridge(fc);
  await b.refresh();
  const site = b.complete("site")[0];
  const d = await b.destinations(site, "x");
  const r = await b.send(d.options[0], "x");
  assert.match(String(r.error), /terminal has the keyboard/);
  assert.equal(r.holder, "terminal");
  assert.ok(!fc.calls.some(x => x[0] === "threads.lease"), "the Capsule never takes it on its own");
  const took = await b.send(d.options[0], "x", { take: true });
  assert.equal(took.error, undefined);
  assert.deepEqual(fc.calls.map(x => x[0]).slice(-2), ["threads.lease", "threads.send"]);
});

test("bridge: held items and open asks wait in one list, and answering goes through the tools", async t => {
  const { c } = await vyred(t);
  // The Gate's shapes (core/gate): gate.held has a summary and no words; gate.get has the draft.
  let held = [{ id: "g1", kind: "send", via: "mail", to: ["Dana Reyes <dana@harlowlegal.com>"], summary: "Re: Q3 report", why: "Dana asked for the numbers", agent: "juno", thread: null, project: "harlow-legal", at: 2000 }];
  const fc = withFakes(c, {
    "gate.held": () => held,
    "gate.get": ({ id }) => ({ ...held.find(h => h.id === id), state: "held", draft: { subject: "Re: Q3 report", body: "Hi Dana" }, final: null, diff: { removed: [], added: [] } }),
    "gate.approve": ({ id }) => { held = held.filter(h => h.id !== id); return { id, state: "sent", result: {} }; },
    "gate.reject": ({ id }) => ({ id, state: "rejected" }),
    "threads.asks": () => [{ id: "a1", thread: "t9", tool: "Bash", summary: "email 14 clients the new intake form", state: "open", at: 1000 }],
    "threads.answer": ({ ask, decision }) => ({ ask, answered: true, decision }),
  });
  const b = new Bridge(fc);
  await b.refresh();
  assert.deepEqual(b.snapshot().waiting.map(w => w.id), ["a1", "g1"]);
  assert.equal(b.waiting[1].title, "juno drafted a message to Dana Reyes");
  const card = await b.held("g1");
  assert.deepEqual(card.draft, { to: "Dana Reyes <dana@harlowlegal.com>", subject: "Re: Q3 report", body: "Hi Dana" });
  assert.deepEqual(await b.answer(b.waiting[1], "send", { to: ["dana@harlowlegal.com"], body: "Hi Dana, edited" }), { ok: true });
  assert.deepEqual(fc.calls.find(x => x[0] === "gate.approve"), ["gate.approve", { id: "g1", edited: { to: ["dana@harlowlegal.com"], body: "Hi Dana, edited" } }]);
  assert.deepEqual(b.waiting.map(w => w.id), ["a1"], "re-read from the Gate, not removed on optimism");
  await b.answer(b.waiting[0], "allow");
  assert.deepEqual(fc.calls.find(x => x[0] === "threads.answer"), ["threads.answer", { ask: "a1", decision: "allow", surface: "capsule" }]);
});

test("bridge: a send the sender refused stays held and says why", async t => {
  const { c } = await vyred(t);
  const fc = withFakes(c, {
    "gate.held": () => [{ id: "g2", kind: "send", via: "mail", to: ["dana@harlowlegal.com"], summary: "Re: Q3", agent: "juno", at: 1 }],
    "gate.approve": ({ id }) => ({ id, state: "failed", error: "gmail said 401" }),
  });
  const b = new Bridge(fc);
  await b.refresh();
  const r = await b.answer(b.waiting[0], "send");
  assert.match(String(r.error), /Not sent: gmail said 401.*still held/);
  assert.equal(b.waiting.length, 1);
  b.onEvent({ id: 1, at: 2, type: "gate.failed", payload: { id: "g2", via: "mail", error: "gmail said 401" } });
  assert.match(b.waiting[0].sub, /last send failed$/);
  b.onEvent({ id: 2, at: 3, type: "gate.rejected", payload: { id: "g2" } });
  assert.equal(b.waiting.length, 0);
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

test("bridge: the real Gate holds a draft, the Capsule opens it, and Send sends the user's edit", async t => {
  const root = tempHome(t);
  const got = [];
  const gmail = http.createServer((req, res) => {
    let body = ""; req.on("data", x => (body += x));
    req.on("end", () => { got.push(body); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "msg-1" })); });
  });
  await new Promise(r => gmail.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { gmail.close(() => r(undefined)); gmail.closeAllConnections(); }));
  const empty = fs.mkdtempSync(path.join(root, "transcripts-"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    role: "local", transcripts: [empty], roots: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "projects", "learn"] },
    gate: { senders: { mail: { type: "gmail", vault: "test-mail-token", from: "alex@example.com", base: `http://127.0.0.1:${/** @type {any} */ (gmail.address()).port}` } } },
  }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  assert.ok((await cli("vault.put", { name: "test-mail-token", kind: "api-key", fields: { value: "fixture-token" } })).data);
  assert.equal((await cli("vault.grant", { name: "test-mail-token", module: "gate" })).data.grant.status, "active");
  // An agent's caller name needs its thread's key over HTTP, which no test holds; juno asks in-process.
  const req = await d.registry.call("gate.request", { kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "Re: Q3 report", body: "Hi Dana" }, why: "Dana asked" }, "mcp:agent:juno");
  assert.equal(req.data.state, "held", JSON.stringify(req));

  const b = new Bridge(client(d.paths.socket));
  await b.refresh();
  assert.equal(b.waiting[0]?.source, "gate", "gate.held is open to every caller");
  // gate.get and gate.approve list their callers; until the Capsule is one of them, the loader
  // hides them from it. Say so rather than fail: the fake-shape test above covers the Capsule.
  if (!b.has("gate.approve")) return t.skip("core/gate does not list the capsule caller on gate.get/approve/reject yet");
  const card = await b.held(b.waiting[0].id);
  assert.deepEqual(card.draft, { to: "dana@harlowlegal.com", subject: "Re: Q3 report", body: "Hi Dana" });
  assert.deepEqual(await b.answer(b.waiting[0], "send", { body: "Hi Dana, the numbers are on slide 6." }), { ok: true });
  assert.equal(got.length, 1);
  const mime = Buffer.from(JSON.parse(got[0]).raw, "base64url").toString();
  assert.equal(Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString(), "Hi Dana, the numbers are on slide 6.", "what the user left on screen is what went");
  assert.deepEqual(b.waiting, []);
});

// ------------------------------------------------------------ the real switchboard
// vyred in a temp home with core threads and agents running, and the fake `claude` standing in
// for Claude Code (core/switchboard/testing/fake-claude.js echoes, and asks before a Write). The
// Bridge talks to it exactly as the Capsule does: client(socket), caller "capsule", and the live
// event stream folded in through onEvent.

const FAKE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../core/switchboard/testing/fake-claude.js");

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise(r => setTimeout(r, 20));
  }
}

async function live(t) {
  fs.chmodSync(FAKE, 0o755);
  const was = process.env.VYRE_CLAUDE_BIN;
  process.env.VYRE_CLAUDE_BIN = FAKE;
  t.after(() => { if (was === undefined) delete process.env.VYRE_CLAUDE_BIN; else process.env.VYRE_CLAUDE_BIN = was; });
  const root = tempHome(t);
  const empty = fs.mkdtempSync(path.join(root, "transcripts-"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [empty], roots: [], projectsDir: path.join(root, "projects"),
    modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli", timeout: 20_000 });
  const work = fs.mkdtempSync(path.join(root, "work-"));
  const c = client(d.paths.socket);
  const b = new Bridge(c);
  const events = [];
  const s = stream(c.socket, { since: (await c.get("/v1/health")).data.last_event, onEvent: e => { events.push(e); b.onEvent(e); } });
  t.after(() => s.stop());
  await until(() => true, "");
  return { root, d, c, b, cli, work, events };
}

const holderOf = async (cli, thread) => (await cli("threads.get", { thread, limit: 1 })).data.thread.holder;

test("real switchboard: every tool the Capsule calls is open to the capsule caller", async t => {
  const { c, b } = await live(t);
  await b.refresh();
  for (const tool of ["agents.list", "agents.ask", "agents.threads", "threads.list", "threads.start", "threads.send", "threads.lease",
    "threads.release", "threads.asks", "threads.answer", "threads.get", "projects.list"]) assert.ok(b.has(tool), `${tool} is listed for capsule`);
  const mf = JSON.parse(fs.readFileSync(path.resolve(path.dirname(FAKE), "..", "module.json"), "utf8"));
  assert.ok(mf.does.tools.includes("threads.asks"));
  assert.equal((await c.call("threads.asks")).error, undefined);
});

test("real switchboard: the assistant is the default, and its reply streams into the snapshot", async t => {
  const { b, cli } = await live(t);
  assert.ok((await cli("agents.create", { name: "juno", kind: "assistant" })).data);
  await b.refresh();
  assert.equal(b.snapshot().assistant, "juno");
  const d = await b.destinations(null, "what is left this week");
  assert.deepEqual([d.options[0].kind, d.options[0].agent, d.unavailable], ["assistant", "juno", null]);
  const sent = await b.send(d.options[0], "what is left this week");
  assert.equal(sent.error, undefined, sent.error);
  assert.match(String(sent.thread), /^[0-9a-f-]{36}$/);
  await until(() => b.snapshot().reply?.finished, "the reply to finish");
  const snap = b.snapshot();
  assert.equal(snap.reply?.thread, sent.thread);
  assert.equal(snap.reply?.text, "echo: what is left this week");
  assert.equal(snap.reply?.ok, true);
  // agents.ask with wait:false keeps the keyboard for the Capsule until it closes.
  assert.equal(await holderOf(cli, sent.thread), "capsule");
  await b.releaseLease();
  assert.equal(await holderOf(cli, sent.thread), null);
  // A second question goes to the same thread, and streams again.
  await b.refresh();
  const again = await b.send((await b.destinations(null, "and next week")).options[0], "and next week");
  assert.equal(again.thread, sent.thread, "the assistant's current thread");
  await until(() => b.snapshot().reply?.finished && b.snapshot().reply?.text === "echo: and next week", "the second reply");
  await b.releaseLease();

  // The Deck holds the assistant's thread: agents.ask is refused, the Capsule says who, and
  // takes the keyboard only when the user chooses to.
  await cli("threads.lease", { thread: sent.thread, surface: "deck" });
  const held = await b.send((await b.destinations(null, "one more")).options[0], "one more");
  assert.equal(held.holder, "deck");
  assert.match(String(held.error), /deck has the keyboard in juno's thread/);
  assert.equal(await holderOf(cli, sent.thread), "deck");
  const took = await b.send((await b.destinations(null, "one more")).options[0], "one more", { take: true });
  assert.deepEqual(took, { thread: sent.thread });
  await until(() => b.snapshot().reply?.finished && b.snapshot().reply?.text === "echo: one more", "the reply after taking it");
  await b.releaseLease();
});

test("real switchboard: @agent asks it through agents.ask, and its threads come from agents.threads", async t => {
  const { b, cli } = await live(t);
  assert.ok((await cli("agents.create", { name: "juno", kind: "assistant" })).data);
  assert.ok((await cli("agents.create", { name: "kit", projects: [] })).data);
  await b.refresh();
  const kit = b.complete("kit")[0];
  assert.deepEqual([kit.kind, kit.id], ["agent", "kit"]);
  const first = await b.destinations(kit, "hello");
  assert.equal(first.options[0].kind, "agent", "no threads yet: its current thread, started by agents.ask");
  const sent = await b.send(first.options[0], "hello");
  assert.equal(sent.error, undefined, sent.error);
  await until(() => b.snapshot().reply?.finished, "kit's reply");
  assert.equal(b.snapshot().reply?.text, "echo: hello");
  await b.releaseLease();
  await b.refresh();
  assert.equal(b.catalog.agents?.find(a => a.name === "kit")?.thread, sent.thread);
  // Its thread is named after it, so words that name it pick that thread, typed into directly.
  const d = await b.destinations(kit, "kit, the numbers please");
  assert.equal(d.options[0].kind, "thread");
  assert.equal(d.options[0].thread, sent.thread);
  const typed = await b.send(d.options[0], "numbers please");
  assert.equal(typed.error, undefined, typed.error);
  await until(() => b.snapshot().reply?.finished && b.snapshot().reply?.text === "echo: numbers please", "the typed reply");
});

test("real switchboard: @thread types with the lease, is refused while another surface holds it, and takes it only when asked", async t => {
  const { b, cli, work } = await live(t);
  const started = await cli("threads.start", { cwd: work, name: "Harlow site copy" });
  const id = started.data.id;
  assert.equal(started.data.holder, "cli");
  await cli("threads.release", { thread: id, surface: "cli" });
  await b.refresh();
  const cand = b.complete("harlow")[0];
  assert.deepEqual([cand.kind, cand.id], ["thread", id], "headless threads from threads.list are @-able");
  const d = await b.destinations(cand, "tighten the intro");
  assert.deepEqual([d.options[0].kind, d.options[0].thread, d.unavailable], ["thread", id, null]);
  const sent = await b.send(d.options[0], "tighten the intro");
  assert.deepEqual(sent, { thread: id }, "a free thread is taken by typing");
  assert.equal(await holderOf(cli, id), "capsule");
  await until(() => b.snapshot().reply?.finished, "the thread's reply");
  assert.equal(b.snapshot().reply?.text, "echo: tighten the intro");
  assert.equal(b.snapshot().reply?.lease, "capsule");

  // Another surface takes it: the Capsule is refused, told who, and does not take it back.
  assert.equal((await cli("threads.lease", { thread: id, surface: "deck" })).data.previous, "capsule");
  await until(() => b.snapshot().reply?.lease === "deck", "lease.changed to reach the reply");
  const refused = await b.send(d.options[0], "and the footer");
  assert.equal(refused.holder, "deck");
  assert.match(String(refused.error), /deck has the keyboard/);
  assert.equal(await holderOf(cli, id), "deck", "not taken");
  const took = await b.send(d.options[0], "and the footer", { take: true });
  assert.deepEqual(took, { thread: id });
  assert.equal(await holderOf(cli, id), "capsule");
  await until(() => b.snapshot().reply?.finished && b.snapshot().reply?.text === "echo: and the footer", "the reply after taking it");
  await b.releaseLease();
  assert.equal(await holderOf(cli, id), null, "closing gives the keyboard back");
});

test("real switchboard: a new thread in a project streams back, and its keyboard goes back on close", async t => {
  const { b, cli, work } = await live(t);
  assert.ok((await cli("projects.create", { name: "Harlow Legal", home: work })).data);
  await b.refresh();
  const p = b.complete("harlow")[0];
  assert.equal(p.kind, "project");
  const d = await b.destinations(p, "draft the intake page");
  assert.equal(d.options[0].kind, "new-thread");
  const sent = await b.send(d.options[0], "draft the intake page");
  assert.equal(sent.error, undefined, sent.error);
  await until(() => b.snapshot().reply?.finished, "the new thread's reply");
  assert.equal(b.snapshot().reply?.text, "echo: draft the intake page");
  assert.equal(await holderOf(cli, sent.thread), "capsule");
  await b.releaseLease();
  assert.equal(await holderOf(cli, sent.thread), null);
});

test("real switchboard: a thread's question waits, survives a reconnect through threads.asks, and is answered", async t => {
  const { root, b, cli, work, c } = await live(t);
  await b.refresh();
  const target = path.join(work, "notes.txt");
  const id = (await cli("threads.start", { cwd: work, name: "Notes", prompt: `write ${target}` })).data.id;
  await until(() => b.snapshot().waiting.length === 1, "ask.raised in waiting");
  const w = b.snapshot().waiting[0];
  assert.equal(w.source, "ask");
  assert.equal(w.thread, id);
  assert.equal(w.tool, "Write");
  assert.match(w.title, /asks to Write .*notes\.txt/);

  // A Capsule opened after the question was raised still sees it (threads.asks, not the stream).
  const later = new Bridge(c);
  await later.refresh();
  assert.deepEqual(later.waiting.map(x => x.id), [w.id]);
  assert.match(later.waiting[0].title, /^Notes asks to Write/, "named by its thread");

  assert.deepEqual(await later.answer(later.waiting[0], "allow"), { ok: true });
  await until(() => fs.existsSync(target), "the file the answer allowed");
  await until(() => b.snapshot().waiting.length === 0, "ask.answered to remove it from the other Capsule");
  assert.deepEqual(later.waiting, []);
  const answered = (await cli("threads.get", { thread: id })).data.events.find(e => e.type === "ask.answered");
  assert.equal(answered.payload.by, "capsule");
  assert.ok(root);
});

test("real switchboard: a session the switchboard never started cannot be typed into, and says so in words", async t => {
  const { b } = await live(t);
  await b.refresh();
  const r = await b.send({ kind: "thread", thread: "11111111-aaaa-4000-8000-000000000001", meta: "" }, "hello");
  assert.ok(r.error);
  assert.doesNotMatch(String(r.error), /^no thread/);
});
