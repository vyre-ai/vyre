// @ts-check
// Who may open a session's stream (reviewer gate C-1, chat-03). Each test is the reviewer's probe: it fails on the code
// that checked only the caller class and bound the ticket to nobody.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { fakeThreads } from "./fake-threads.js";
import { connect, wsDuplex } from "./client.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAROL = "carol@example.com", DAVE = "dave@example.com", BOB = "bob@example.com", ALEX = "alex@example.com";

async function world(t) {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box" }, paths: p, log: () => {} });
  const fake = fs.mkdtempSync(path.join(SCRATCH, "vyre-stream-access-"));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  fakeThreads(fake);
  await reg.start([...discover([CORE]).filter(f => f.manifest && f.manifest.name === "stream"), ...discover([fake], { firstPartyRoots: [fake] })], { role: "box" });
  assert.equal(reg.modules.get("stream")?.state, "running", reg.modules.get("stream")?.error);
  const w = { upgradeAs: "deck" };
  const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  s.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://vyred");
    const u = reg.upgrades.get("stream/session");
    u.handler(req, socket, head, { caller: w.upgradeAs, url });
  });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  t.after(async () => { s.closeAllConnections(); s.close(); await reg.stop(); db.close(); });
  const as = (login, caller = `tailnet:${login}`) => (tool, input) => reg.call(tool, input, caller, { peer: { login, stableId: `n_${login}` } });
  const status = path => new Promise(resolve => {
    const r = http.request({ port, host: "127.0.0.1", path, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    r.on("response", res => resolve(res.statusCode));
    r.on("upgrade", (_res, sock) => { sock.destroy(); resolve(101); });
    r.on("error", () => resolve(0));
    r.end();
  });
  return { reg, w, as, status, port, stream: () => reg.modules.get("stream")?.handle };
}
const ok = r => { assert.ok(!r.error, r.error && `${r.error.code} ${r.error.message}`); return r.data; };
const codeOf = r => (r.error ? r.error.code : "ok");

/** A group of carol and dave, made by carol. */
async function group(w, session = "grp_cd") {
  ok(await w.as(CAROL)("stream.send", { session, text: "hello dave", people: [`person:${DAVE}`], to: [] }));
  return session;
}

test("C-1: cli, capsule, local, deck and tailnet:bob are each refused a chat between carol and dave; the two people open it", async t => {
  const w = await world(t);
  const session = await group(w);
  for (const caller of ["cli", "capsule", "local", "deck"]) assert.equal(codeOf(await w.reg.call("stream.open", { session }, caller)), "not_found", caller);
  assert.equal(codeOf(await w.as(BOB)("stream.open", { session })), "not_found", "bob on the tailnet");
  // an `as` claim by a tailnet device is not believed: the verified peer decides
  assert.equal(codeOf(await w.as(BOB)("stream.open", { session, as: `person:${CAROL}` })), "not_found");
  const c = ok(await w.as(CAROL)("stream.open", { session }));
  assert.equal(c.viewer, `person:${CAROL}`);
  ok(await w.as(DAVE)("stream.open", { session }));
  assert.ok(c.head >= 1);
});

test("C-1: an owner or admin is not a reader of a chat they are not in", async t => {
  const w = await world(t);
  const session = await group(w);
  // the box owner's own surface (person:owner) is an ordinary person here: no grant to read a chat of others
  assert.equal(codeOf(await w.reg.call("stream.open", { session, as: "person:owner" }, "cli")), "not_found");
  // and cannot speak in it, react, pin or move a marker either
  for (const [tool, input] of [["stream.send", { text: "hi" }], ["stream.react", { message: "m1", emoji: "x" }], ["stream.pin", { message: "m1" }], ["stream.mark-read", { upto: 1 }]]) {
    assert.equal(codeOf(await w.reg.call(tool, { session, ...input }, "cli")), "not_found", tool);
  }
});

test("C-1: an assistant acting for alex cannot open a chat between carol and dave, nor any chat through the person-surface call", async t => {
  const w = await world(t);
  const session = await group(w);
  const mine = "grp_alex";
  ok(await w.as(ALEX)("stream.send", { session: mine, text: "note to self", people: [], to: [] }));
  const assistant = (tool, input) => w.reg.call(tool, input, "cli:agent:kit", { peer: { login: ALEX, stableId: `n_${ALEX}` } });
  // stream.open is a person's surface call: the registry refuses an agent caller before the tool runs
  // (the reach rule). An assistant reads a chat only through the kernel, with a session token that
  // carries its chat and the person it acts for (kernel.test.js: member A's assistant on a B/C chat).
  for (const input of [{ session }, { session, as: `person:${CAROL}` }, { session: mine }]) {
    const r = await assistant("stream.open", input);
    assert.equal(codeOf(r), "denied", JSON.stringify(input));
    assert.match(String(r.error && r.error.message), /not available to cli callers/);
  }
  // and alex himself still opens his own chat
  assert.equal(codeOf(await w.as(ALEX)("stream.open", { session: mine })), "ok");
});

test("C-1: a ticket minted by one caller fails for another, works once for the same caller", async t => {
  const w = await world(t);
  const session = await group(w);
  const o = ok(await w.as(CAROL, "deck")("stream.open", { session }));
  w.w.upgradeAs = "cli";
  assert.equal(await w.status(o.path), 403, "another caller");
  w.w.upgradeAs = "deck";
  assert.equal(await w.status(o.path), 403, "spent by the refused attempt, not left to be tried again");
  const o2 = ok(await w.as(CAROL, "deck")("stream.open", { session }));
  assert.equal(await w.status(o2.path), 101);
  assert.equal(await w.status(o2.path), 403, "one use");
});

test("C-1: a ticket lives 15 s, not 30", async t => {
  const w = await world(t);
  const session = await group(w);
  const o = ok(await w.as(CAROL, "deck")("stream.open", { session }));
  const h = w.stream();
  assert.ok(h.logs.has(session));
  const real = Date.now;
  Date.now = () => real() + 16_000;
  try { assert.equal(await w.status(o.path), 403); } finally { Date.now = real; }
});

test("C-1: an unknown session id is refused before a log is made, however many are tried", async t => {
  const w = await world(t);
  const before = w.stream().logs.logs.size;
  for (let i = 0; i < 50; i++) assert.equal(codeOf(await w.reg.call("stream.open", { session: `ghost_${i}` }, "deck")), "not_found");
  assert.equal(w.stream().logs.logs.size, before, "no log for a refused id");
});

test("C-1: a thread is read through threads.get AS THE CALLER, and its refusal is the answer", async t => {
  const w = await world(t);
  globalThis.__fakeThreadsCalls = [];
  assert.equal(codeOf(await w.as(BOB)("stream.open", { session: "locked_1" })), "denied");
  assert.equal(codeOf(await w.reg.call("stream.open", { session: "locked_1" }, "deck")), "ok");
  assert.equal(codeOf(await w.reg.call("stream.open", { session: "thr_9" }, "deck")), "ok");
  const calls = globalThis.__fakeThreadsCalls.filter(c => c.thread === "locked_1");
  assert.deepEqual(calls.map(c => c.caller), [`tailnet:${BOB}`, "deck"], "asked under each caller's own label, not the module's");
});

test("C-3: over the real socket the ticket's viewer is drawn for: a sealed field reaches the second person as a placeholder with no ref", async t => {
  const w = await world(t);
  const session = await group(w);
  w.stream().logs.get(session).append("tool-finished", { tool_id: "t1", ok: true, result: { block: "record", title: "Matter", fields: [
    { name: "ssn", label: "SSN", kind: "sealed", value: { sealed: "ssn", ref: "seal:abc-9f31", present: true, valid_format: true, set_at: 1 } }] } }, { author: "assistant:kit", acts_for: `person:${CAROL}` });
  /** @type {any[]} */ const got = [];
  const c = connect({ open: async ({ from }) => { const o = ok(await w.as(DAVE, "deck")("stream.open", { session, from })); return wsDuplex(`ws://127.0.0.1:${w.port}${o.path}`); }, onFrame: f => got.push(f), backoff: { base: 5, cap: 10 } });
  t.after(() => c.close());
  const until = async p => { const end = Date.now() + 5000; while (!p() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(p()); };
  await until(() => got.some(f => f.type === "session.tool-finished"));
  const rec = got.find(f => f.type === "session.tool-finished");
  assert.equal(rec.data.result.fields[0].placeholder, true);
  assert.ok(!JSON.stringify(got).includes("seal:abc-9f31"));
});

test("private: stream.send with enc is stored and relayed as it is, routed to no assistant, and the home holds no words", async t => {
  const w = await world(t);
  const session = await group(w);
  const enc = { alg: "mls-x", kid: "dev:carol#1", ct: "q83vEjRWeJq83vEjRWeJ" };
  const r = ok(await w.as(CAROL)("stream.send", { session, enc, message: "p1", assistants: [{ id: "assistant:kit", cwd: "/tmp" }], default: "assistant:kit" }));
  assert.deepEqual([r.private, r.routed, r.answers], [true, [], []]);
  const frame = w.stream().logs.get(session).read(0).find(f => f.data.message === "p1");
  assert.deepEqual(frame.data, { message: "p1", enc, state: "sent" });
  assert.equal(frame.author, `person:${CAROL}`);
  assert.equal(codeOf(await w.as(CAROL)("stream.send", { session, enc, text: "and words" })), "bad_input");
  assert.equal(codeOf(await w.as(CAROL)("stream.send", { session, enc: { alg: "x" } })), "bad_input");
  assert.equal(ok(await w.as(CAROL)("stream.send", { session, enc, message: "p1" })).duplicate, true, "the same message id is not stored twice");
  // nobody outside the chat reads it
  assert.equal(codeOf(await w.as(BOB)("stream.open", { session })), "not_found");
});
