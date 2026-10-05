// @ts-check
// Who may open a session's stream (reviewer gate C-1, chat-03), on a real kernel: a chat's readers are the people the kernel lists, and a call that carries no person of its
// own reads no chat. Each test is the reviewer's probe: it fails on the code that checked only the caller class and bound the ticket to nobody.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover, currentCall } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { fakeThreads } from "./fake-threads.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", CAROL = "per_carol", DAVE = "per_dave", ADA = "per_ada";
const used = new Set();
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };

async function world(t) {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  k.bindCalls(currentCall);
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[CAROL, "manager"], [DAVE, "member"], [ADA, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const dev = (/** @type {string} */ person, /** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const chains = { owner, carol: dev(CAROL, "d-c"), dave: dev(DAVE, "d-d"), ada: dev(ADA, "d-a") };
  /** @type {Record<string, string>} */ const tokens = {};
  for (const [n, c] of Object.entries(chains)) tokens[n] = (await k.surfaces.open(c, {})).token;
  tokens.adaKit = (await k.surfaces.open(chains.ada, { agent: "kit" })).token;
  // CH-7: a chain made from a session token is delegated; here a token stands for the person's own direct chain (the daemon's authenticated surface).
  const direct = new Map(Object.entries(tokens).map(([n, tok]) => [tok, /** @type {any} */ (chains)[n]]).filter(([, c]) => c));
  const kernelFor = (/** @type {any} */ m) => { const h = k.kernelFor(m); return Object.freeze({ ...h, chain: async (/** @type {any} */ meta) => (meta && direct.get(meta.token)) || h.chain(meta) }); };
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box" }, paths: p, log: () => {}, kernelFor });
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
  /** A call as a person, under the person's own session token. */
  const as = (/** @type {string} */ who, caller = "deck") => (/** @type {string} */ tool, /** @type {any} */ input) => reg.call(tool, input, caller, { token: tokens[who] });
  const status = (/** @type {string} */ path) => new Promise(resolve => {
    const r = http.request({ port, host: "127.0.0.1", path, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    r.on("response", res => resolve(res.statusCode));
    r.on("upgrade", (_res, sock) => { sock.destroy(); resolve(101); });
    r.on("error", () => resolve(0));
    r.end();
  });
  return { k, reg, w, as, status, port, C: g.chats, chains, stream: () => reg.modules.get("stream")?.handle };
}
const ok = (/** @type {any} */ r) => { assert.ok(!r.error, r.error && `${r.error.code} ${r.error.message}`); return r.data; };
const codeOf = (/** @type {any} */ r) => (r.error ? r.error.code : "ok");

/** A chat of carol and dave, made by carol, with one message in it. */
async function group(/** @type {any} */ w) {
  const chat = await w.C.create(w.chains.carol, { people: [DAVE], assistants: [] });
  ok(await w.as("carol")("stream.send", { session: chat.id, text: "hello dave", to: [] }));
  return chat.id;
}

test("C-1: a label with no person, a person outside the chat and the owner are each refused a chat between carol and dave; the two people open it", async t => {
  const w = await world(t);
  const session = await group(w);
  for (const caller of ["cli", "capsule", "local", "deck"]) assert.equal(codeOf(await w.reg.call("stream.open", { session }, caller)), "not_found", caller);
  assert.equal(codeOf(await w.as("ada")("stream.open", { session })), "not_found", "ada is not in the chat");
  // an `as` claim is not believed: the kernel's chain decides
  assert.equal(codeOf(await w.as("ada")("stream.open", { session, as: `person:${CAROL}` })), "not_found");
  const c = ok(await w.as("carol")("stream.open", { session }));
  assert.equal(c.viewer, `person:${CAROL}`);
  ok(await w.as("dave")("stream.open", { session }));
  assert.ok(c.head >= 1);
});

test("C-1: an owner or admin is not a reader of a chat they are not in", async t => {
  const w = await world(t);
  const session = await group(w);
  // the box owner is an ordinary person here: no grant to read a chat of others
  assert.equal(codeOf(await w.as("owner")("stream.open", { session })), "not_found");
  // and cannot speak in it, react, pin or move a marker either
  for (const [tool, input] of [["stream.send", { text: "hi" }], ["stream.react", { message: "m1", emoji: "x" }], ["stream.pin", { message: "m1" }], ["stream.mark-read", { upto: 1 }]]) {
    assert.equal(codeOf(await w.as("owner")(tool, { session, ...input })), "not_found", tool);
  }
});

test("C-1: an assistant acting for ada cannot open a chat between carol and dave", async t => {
  const w = await world(t);
  const session = await group(w);
  assert.equal(codeOf(await w.as("adaKit")("stream.open", { session })), "not_found");
  assert.equal(codeOf(await w.as("adaKit")("stream.open", { session, as: `person:${CAROL}` })), "not_found");
  // an assistant claim no daemon bound to a session (no thread) is refused outright (reviewer-2 R-1), never read as the person
  assert.equal(codeOf(await w.reg.call("stream.open", { session }, "cli:agent:kit", { peer: { login: "ada@example.com", stableId: "n_ada" } })), "denied");
});

test("C-1: a ticket minted by one caller fails for another, works once for the same caller", async t => {
  const w = await world(t);
  const session = await group(w);
  const o = ok(await w.as("carol", "deck")("stream.open", { session }));
  w.w.upgradeAs = "cli";
  assert.equal(await w.status(o.path), 403, "another caller");
  w.w.upgradeAs = "deck";
  assert.equal(await w.status(o.path), 403, "spent by the refused attempt, not left to be tried again");
  const o2 = ok(await w.as("carol", "deck")("stream.open", { session }));
  assert.equal(await w.status(o2.path), 101);
  assert.equal(await w.status(o2.path), 403, "one use");
});

test("C-1: a ticket lives 15 s, not 30", async t => {
  const w = await world(t);
  const session = await group(w);
  const o = ok(await w.as("carol", "deck")("stream.open", { session }));
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
  for (let i = 0; i < 50; i++) assert.equal(codeOf(await w.as("carol")("stream.open", { session: `ghost_${i}` })), "not_found");
  assert.equal(w.stream().logs.logs.size, before, "no log for a refused id");
});

test("C-1: a thread is read through threads.get AS THE CALLER, and its refusal is the answer", async t => {
  const w = await world(t);
  globalThis.__fakeThreadsCalls = [];
  globalThis.__fakeThreadsKnown = new Map([["locked_1", { cwd: "/tmp", deny: "^cli$" }]]);
  assert.equal(codeOf(await w.reg.call("stream.open", { session: "locked_1" }, "cli")), "denied");
  assert.equal(codeOf(await w.reg.call("stream.open", { session: "locked_1" }, "deck")), "ok");
  assert.equal(codeOf(await w.reg.call("stream.open", { session: "thr_9" }, "deck")), "ok");
  const calls = globalThis.__fakeThreadsCalls.filter(c => c.thread === "locked_1");
  assert.deepEqual(calls.map(c => c.caller), ["cli", "deck"], "asked under each caller's own label, not the module's");
});

test("private: stream.send with enc is stored and relayed as it is, routed to no assistant, and the home holds no words", async t => {
  const w = await world(t);
  const session = await group(w);
  const enc = { alg: "mls-x", kid: "dev:carol#1", ct: "q83vEjRWeJq83vEjRWeJ" };
  const r = ok(await w.as("carol")("stream.send", { session, enc, message: "p1" }));
  assert.deepEqual([r.private, r.routed, r.answers], [true, [], []]);
  const frame = w.stream().logs.get(session).read(0).find((/** @type {any} */ f) => f.data.message === "p1");
  assert.deepEqual(frame.data, { message: "p1", enc, state: "sent" });
  assert.equal(frame.author, `person:${CAROL}`);
  assert.equal(codeOf(await w.as("carol")("stream.send", { session, enc, text: "and words" })), "bad_input");
  assert.equal(codeOf(await w.as("carol")("stream.send", { session, enc: { alg: "x" } })), "bad_input");
  assert.equal(ok(await w.as("carol")("stream.send", { session, enc, message: "p1" })).duplicate, true, "the same message id is not stored twice");
  // nobody outside the chat reads it
  assert.equal(codeOf(await w.as("ada")("stream.open", { session })), "not_found");
});
