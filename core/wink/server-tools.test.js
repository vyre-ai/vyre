// @ts-check
// The paired server from this computer: wink.server.home / call / health / events, and wink.events.read on the server. Against a fake peer session (the real relay call is in test/wink-paired.test.js).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { serverTools } from "./server-tools.js";

const owner = (/** @type {any} */ meta) => { const c = String((meta && meta.caller) || ""); if (!c || c.startsWith("agent:") || c.startsWith("tailnet-guest:")) throw Object.assign(new Error("denied"), { code: "denied" }); };

function rig(o = {}) {
  /** @type {Map<string, any>} */ const tools = new Map(); /** @type {Map<string, any>} */ const routes = new Map();
  /** @type {any[]} */ const calls = [];
  const log = /** @type {any[]} */ ([]); const sinceCalls = /** @type {number[]} */ ([]);
  let clock = 1000;
  const answers = /** @type {any} */ ({ "system.info": () => ({ ok: true }), "names.status": () => ({ name: "alex", via: "vyre.run", address: "100.64.0.9" }), ...(o.answers || {}) });
  const session = { call: async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.push([tool, input]); if (o.down) throw Object.assign(new Error("the server could not be reached"), { code: "unreachable" }); const f = answers[tool]; if (!f) throw Object.assign(new Error("no such tool"), { code: "no_such_tool" }); return f(input); } };
  const ctx = { tool: (n, d) => tools.set(n, d), route: (n, f) => routes.set(n, f), events: { since: (since, x) => (sinceCalls.push(since), log).filter(e => e.id > since && (!x.type || e.type === x.type)).slice(0, x.limit), latestId: () => (log.length ? log[log.length - 1].id : 0) } };
  const devices = { list: () => (o.noServer ? [] : [{ id: "srv1", kind: "server", name: "Alex's server" }, { id: "ph1", kind: "phone", name: "phone" }]) };
  const h = serverTools({ ctx, owner, identity: async () => "ident", serverLinks: () => ({ sessionFor: (/** @type {string} */ sid) => { assert.equal(sid, "srv1"); return session; } }), homeServerId: () => (o.noServer ? null : "srv1"), devices, now: () => (clock += 1) });
  const run = (/** @type {string} */ n, /** @type {any} */ i = {}, /** @type {any} */ meta = { caller: "cli" }) => tools.get(n).run(i, meta);
  return { run, tools, routes, calls, log, h, sinceCalls };
}

test("wink.server.home: the paired server, whether it answers, and its https name; nothing paired is { linked: false }", async () => {
  const r = rig();
  const home = await r.run("wink.server.home");
  assert.equal(home.linked, true); assert.equal(home.reachable, true);
  assert.deepEqual(home.box, { device: "srv1", name: "Alex's server", address: "https://alex.vyre.run" }, "a bare IP is not an address; the name under vyre.run is");
  assert.equal(home.via, "wink");
  assert.deepEqual(await rig({ noServer: true }).run("wink.server.home"), { linked: false });
  const down = await rig({ down: true }).run("wink.server.home");
  assert.equal(down.linked, true); assert.equal(down.reachable, false); assert.match(down.error, /reached|answer/);
});

test("wink.server.health: reach, latency and since, cached; unreachable says why", async () => {
  const r = rig();
  const a = await r.run("wink.server.health"); assert.deepEqual([a.state, a.path, a.dot, a.reach], ["relayed", "relay", "relay", "relay"]); assert.equal(typeof a.handshake, "number"); assert.equal(typeof a.latencyMs, "number");
  const n = r.calls.length; await r.run("wink.server.health"); assert.equal(r.calls.length, n, "a second read inside 15 seconds asks nothing");
  await r.run("wink.server.health", { fresh: true }); assert.ok(r.calls.length > n, "fresh asks again");
  const d = await rig({ down: true }).run("wink.server.health"); assert.deepEqual([d.state, d.reach, d.reachable], ["offline", "none", false]); assert.ok(d.why);
  assert.equal((await rig({ noServer: true }).run("wink.server.health")).reach, "none");
});

test("wink.server.call forwards one tool and returns the server tool's own answer, adds the proof to the input, names an unreachable server server_unreachable, and refuses what is not a paired server", async () => {
  const r = rig({ answers: { "records.me": (/** @type {any} */ i) => ({ me: "x", got: i }) } });
  assert.deepEqual(await r.run("wink.server.call", { tool: "records.me", input: { a: 1 }, proof: { k: 1 } }), { me: "x", got: { a: 1, proof: { k: 1 } } });
  await assert.rejects(r.run("wink.server.call", { tool: "records.me", device: "ph1" }), e => e.code === "not_found", "a phone is not a server");
  await assert.rejects(r.run("wink.server.call", { tool: "../x" }), e => e.code === "bad_input");
  await assert.rejects(r.run("wink.server.call", { tool: "nope.tool" }), e => e.code === "no_such_tool", "the server's own refusal comes through");
  await assert.rejects(rig({ down: true }).run("wink.server.call", { tool: "records.me" }), e => e.code === "server_unreachable");
});

test("the person's own only: an agent, a guest, a model's module hop are refused on every tool", async () => {
  const r = rig();
  for (const n of ["wink.server.home", "wink.server.health", "wink.server.call", "wink.server.events", "wink.events.read"]) {
    for (const meta of [{ caller: "agent:kit" }, { caller: "tailnet-guest:x" }, { caller: "mcp" }, { caller: "cli", origin: "mcp" }, { caller: "module:foo" }])
      await assert.rejects(r.run(n, { tool: "x" }, meta), e => e.code === "denied", `${n} for ${JSON.stringify(meta)}`);
  }
});

test("wink.events.read: events after a cursor with the new cursor; waits for the first new event; the limit and wait are capped", async () => {
  const r = rig(); r.log.push({ id: 1, type: "a" }, { id: 2, type: "b" }, { id: 3, type: "a" });
  assert.deepEqual(await r.run("wink.events.read", { since: 1 }), { events: [{ id: 2, type: "b" }, { id: 3, type: "a" }], cursor: 3 });
  assert.deepEqual((await r.run("wink.events.read", { since: 0, type: "a", limit: 1 })).events, [{ id: 1, type: "a" }]);
  assert.deepEqual(await r.run("wink.events.read", { since: 3 }), { events: [], cursor: 3 }, "nothing new: the cursor stands");
  const g = rig(); g.log.push({ id: 1, type: "thread.msg" }, { id: 2, type: "memory.x" }, { id: 3, type: "thread.done" }, { id: 4, type: "ask.q" });
  assert.deepEqual((await g.run("wink.events.read", { since: 0, type: "thread.*" })).events.map(e => e.id), [1, 3], "a prefix matches by type start");
  assert.equal((await g.run("wink.events.read", { since: 0, type: "thread.*" })).cursor, 4, "the cursor passes what was scanned");
  assert.deepEqual((await g.run("wink.events.read", { since: 3, type: "thread.*" })), { events: [], cursor: 4 });
  assert.equal((await g.run("wink.events.read", { since: 0, type: "*" })).events.length, 4);
  // a waiting prefix read does not rescan the same stretch of the log on every poll
  const q = rig(); q.log.push({ id: 1, type: "memory.a" }, { id: 2, type: "memory.b" });
  setTimeout(() => q.log.push({ id: 3, type: "thread.z" }), 900);
  const got = await q.run("wink.events.read", { since: 0, type: "thread.*", wait_ms: 5000 });
  assert.deepEqual(got.events.map(e => e.id), [3]);
  assert.ok(q.sinceCalls.filter(n => n === 0).length === 1 && q.sinceCalls.length >= 3, `later polls start after what was scanned: ${q.sinceCalls.join(",")}`);
  assert.deepEqual((await g.run("wink.events.read", { since: 0, types: ["thread.*", "ask.q"] })).events.map(e => e.id), [1, 3, 4], "several types are an OR");
  assert.deepEqual((await g.run("wink.events.read", { since: 0, types: ["memory.x"] })).events.map(e => e.id), [2], "an exact type");
  for (const bad of ["th*ead", "thread*", "*.x", "a b", "thread.**"]) await assert.rejects(g.run("wink.events.read", { type: bad }), e => e.code === "bad_input", bad);
  setTimeout(() => r.log.push({ id: 4, type: "c" }), 100);
  const t0 = Date.now(); const w = await r.run("wink.events.read", { since: 3, wait_ms: 5000 });
  assert.deepEqual(w.events.map((/** @type {any} */ e) => e.id), [4]); assert.ok(Date.now() - t0 < 3000, "it returned when the event came, not at the end of the wait");
});

test("wink.server.events asks the paired server for its events after the cursor, and says server_unreachable when it is away", async () => {
  const r = rig({ answers: { "wink.events.read": (/** @type {any} */ i) => ({ events: [{ id: i.since + 1, type: "x" }], cursor: i.since + 1 }) } });
  assert.deepEqual(await r.run("wink.server.events", { since: 7, type: "thread.*" }), { events: [{ id: 8, type: "x" }], cursor: 8 });
  assert.deepEqual(r.calls.at(-1), ["wink.events.read", { since: 7, type: "thread.*", limit: undefined, wait_ms: 0 }]);
  await assert.rejects(rig({ down: true }).run("wink.server.events", {}), e => e.code === "server_unreachable");
});

test("the SSE route streams the server's events as link did, says link.down when it is away and refuses a caller that is not the person", async () => {
  let n = 0;
  const r = rig({ answers: { "wink.events.read": () => (++n === 1 ? { events: [{ id: 5, type: "thread.msg", payload: { a: 1 } }], cursor: 5 } : new Promise(() => {})) } });
  const chunks = /** @type {string[]} */ ([]); let head = 0; const closers = /** @type {any[]} */ ([]);
  const res = { writeHead: (/** @type {number} */ s) => { head = s; }, write: (/** @type {string} */ s) => { chunks.push(s); }, end() { chunks.push("END"); } };
  const req = { headers: {}, on: (/** @type {string} */ e, /** @type {any} */ f) => { if (e === "close") closers.push(f); } };
  r.routes.get("server-events")(req, res, { caller: "cli", url: new URL("http://x/v1/wink/server-events?type=thread.*&type=ask.*&since=2") });
  for (let i = 0; i < 50 && chunks.length < 1; i++) await new Promise(x => setTimeout(x, 20));
  assert.equal(head, 200); assert.match(chunks.join(""), /id: 5\nevent: thread\.msg\ndata: .*"source":"box"/);
  const asked = r.calls.find(c => c[0] === "wink.events.read")[1]; assert.deepEqual([asked.types, asked.since], [["thread.*", "ask.*"], 2], "several ?type= values and ?since= go to the server");
  closers[0](); assert.ok(chunks.includes("END"));
  const bad = { code: 0, body: "" }; const res2 = { writeHead: (/** @type {number} */ s) => { bad.code = s; }, end: (/** @type {string} */ b) => { bad.body = b; }, write() {} };
  r.routes.get("server-events")({ headers: {}, on() {} }, res2, { caller: "agent:kit", url: new URL("http://x/v1/wink/server-events") });
  assert.equal(bad.code, 403);
  const d = rig({ down: true }); const c2 = /** @type {string[]} */ ([]); const cl = /** @type {any[]} */ ([]);
  d.routes.get("server-events")({ headers: {}, on: (/** @type {string} */ e, /** @type {any} */ f) => { if (e === "close") cl.push(f); } }, { writeHead() {}, write: (/** @type {string} */ s) => { c2.push(s); }, end() {} }, { caller: "cli", url: new URL("http://x/v1/wink/server-events") });
  for (let i = 0; i < 50 && !c2.length; i++) await new Promise(x => setTimeout(x, 20));
  assert.match(c2.join(""), /event: link\.down/); cl[0]();
});
