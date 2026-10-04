// @ts-check
// Task N: the stream on a real kernel, every message through chats.append (chat 0.3). A chat's token carries the chat from birth; a person's words and an
// assistant's reply are written by the kernel BEFORE the stream stores or sends them; a refused reply is shown nowhere; nobody joins by a call; a cited field
// is the kernel's own records.get drawn per viewer; and the room view agrees with the stream's own drop of an assistant's field value.
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
import { CONTACT } from "../../kernel/conformance/suite.js";
import { connect, wsDuplex } from "./client.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada";
const used = new Set();
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };

/** A threads module with start, send and get; the test emits the thread's events itself. */
function fakeThreadsFull(/** @type {string} */ dir) {
  const d = path.join(dir, "threads");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "module.json"), JSON.stringify({ name: "threads", version: "0.0.0", roles: ["box", "local"], requires: [], does: { tools: [{ name: "threads.get", reach: "person" }, { name: "threads.start", reach: "anyone" }, { name: "threads.send", reach: "anyone" }] }, watches: { emits: [] }, shows: {}, needs: {}, teaches: { tips: [] }, settings: [] }));
  fs.writeFileSync(path.join(d, "index.js"), `
const callers = ["cli", "local", "deck", "capsule", "tailnet", "mcp", "harness", "module"];
export default { async start(ctx) {
  const T = globalThis.__threadsFull = globalThis.__threadsFull || { n: 0, started: [], sent: [] };
  ctx.tool("threads.get", { description: "fake", input: { type: "object", properties: { thread: { type: "string" }, limit: { type: "integer" } }, required: ["thread"] }, callers,
    run: async (i) => { const e = (c) => Object.assign(new Error(c), { code: c }); if (/^thr_/.test(i.thread)) return { thread: { id: i.thread, cwd: "/tmp" }, events: [] }; throw e("not_found"); } });
  ctx.tool("threads.start", { description: "fake", input: { type: "object", properties: { cwd: { type: "string" }, prompt: { type: "string" }, surface: { type: "string" } }, required: ["cwd"] }, callers,
    run: async (i) => { const id = "thr_" + (++T.n); T.started.push({ id, ...i }); return { id }; } });
  ctx.tool("threads.send", { description: "fake", input: { type: "object", properties: { thread: { type: "string" }, text: { type: "string" }, surface: { type: "string" }, uuid: { type: "string" } }, required: ["thread", "text"] }, callers,
    run: async (i) => { T.sent.push(i); return { ok: true }; } });
  return {};
} };
`);
}

async function world(t) {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  k.bindCalls(currentCall);
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "manager"], [CAROL, "member"], [ADA, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  for (const id of ["kit", "juno"]) { const a = { kind: "agent", id, space: SPACE }; await g.addActor(owner, a, { presence: proof("grants.role", { actor: a }, `vyre://${SPACE}/member/${id}`) }); }
  const dev = (/** @type {string} */ person, /** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const chains = { owner, bob: dev(BOB, "d-b"), carol: dev(CAROL, "d-c"), ada: dev(ADA, "d-a") };
  /** @type {Record<string, string>} */ const tokens = {};
  for (const [n, c] of Object.entries(chains)) tokens[n] = (await k.surfaces.open(c, {})).token;
  tokens.adaKit = (await k.surfaces.open(chains.ada, { agent: "kit" })).token;
  globalThis.__threadsFull = { n: 0, started: [], sent: [] };

  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const events = new Events(db);
  // CH-7: a chain made from a session token is delegated and cannot open another session. The stream opens each assistant's session from the chain of the call, so
  // here a token stands for the person's own direct chain (the daemon's authenticated surface); the real wiring for a delegated chain is the sessions team's per-thread session.
  const direct = new Map(Object.entries(tokens).map(([n, tok]) => [tok, /** @type {any} */ (chains)[n]]).filter(([, c]) => c));
  const kernelFor = (/** @type {any} */ m) => { const h = k.kernelFor(m); return Object.freeze({ ...h, chain: async (/** @type {any} */ meta) => (meta && direct.get(meta.token)) || h.chain(meta) }); };
  const reg = new Registry({ db, events, config: { role: "box" }, paths: p, log: m => { if (process.env.DBG) console.log("LOG", m); }, kernelFor });
  const fake = fs.mkdtempSync(path.join(SCRATCH, "vyre-stream-n-"));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  fakeThreadsFull(fake);
  await reg.start([...discover([CORE]).filter(f => f.manifest && f.manifest.name === "stream"), ...discover([fake], { firstPartyRoots: [fake] })], { role: "box" });
  assert.equal(reg.modules.get("stream")?.state, "running", reg.modules.get("stream")?.error);
  const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  s.on("upgrade", (req, socket, head) => { reg.upgrades.get("stream/session").handler(req, socket, head, { caller: "deck", url: new URL(req.url || "/", "http://vyred") }); });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  t.after(async () => { s.closeAllConnections(); s.close(); await reg.stop(); db.close(); });
  const as = (/** @type {string} */ who) => (/** @type {string} */ tool, /** @type {any} */ input) => reg.call(tool, input, "deck", { token: tokens[who] });
  /** A thread's words, the way the switchboard emits them. */
  const say = (/** @type {string} */ thread, /** @type {string} */ message, /** @type {string} */ text, extra = {}) => {
    events.emit("threads", "thread.text", { message, block: 0, delta: text.slice(0, Math.ceil(text.length / 2)) }, { thread });
    events.emit("threads", "thread.text", { message, block: 0, delta: text.slice(Math.ceil(text.length / 2)) }, { thread });
    events.emit("threads", "thread.text", { message, block: 0, done: true, ...extra }, { thread });
  };
  const idle = async () => { await new Promise(r => setTimeout(r, 20)); await stream().groups.idle(); };
  const stream = () => reg.modules.get("stream")?.handle;
  const frames = (/** @type {string} */ chat) => stream().logs.get(chat).read(0);
  const kernelMsgs = () => k.log.read({ type: "message.added" });
  return { k, chains, tokens, as, reg, port, stream, events, say, idle, frames, kernelMsgs, C: g.chats, threads: () => globalThis.__threadsFull };
}
const codeOf = (/** @type {any} */ r) => (r.error ? r.error.code : "ok");
const ok = (/** @type {any} */ r) => { assert.ok(!r.error, r.error && `${r.error.code} ${r.error.message}`); return r.data; };
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

/** The chat of bob and carol with kit and juno listed; bob asks kit. */
async function asked(/** @type {any} */ w, people = [CAROL], assistants = ["kit"]) {
  const chat = await w.C.create(w.chains.bob, { people, assistants });
  const sent = ok(await w.as("bob")("stream.send", { session: chat.id, text: "what is the fee?", to: ["assistant:kit"], cwd: "/tmp" }));
  await w.idle();
  const th = w.threads().started[0];
  assert.ok(th, "the assistant's thread started");
  return { chat, sent, thread: th.id };
}

test("every message goes through chats.append under a token that carries the chat: a person's send and an assistant's reply", async t => {
  const w = await world(t);
  const { chat, thread } = await asked(w);
  const first = w.kernelMsgs();
  assert.equal(first.length, 1, "bob's words went through the kernel first");
  assert.equal(first[0].data.chat, chat.id);
  assert.deepEqual(first[0].data.by, { person: BOB });
  assert.ok(!JSON.stringify(first).includes("what is the fee"), "the kernel keeps a hash, never the text");
  const sentFrame = w.frames(chat.id).find((/** @type {any} */ f) => f.type === "session.user-message");
  assert.ok(sentFrame.data.kid, "the stream stores the text under the kernel's id");
  assert.equal(sentFrame.data.kid, first[0].data.id);
  // kit answers: the reply streams (the first delta opens it, stamped with the room's membership version); the kernel takes the whole text when it closes
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, delta: "The fee is " }, { thread });
  await w.idle();
  const partial = w.frames(chat.id).filter((/** @type {any} */ f) => f.type === "session.text-delta");
  assert.equal(partial.length, 1, "the first delta is shown at once, not held until the message is whole");
  assert.ok(Number.isInteger(partial[0].data.ver), "and it is stamped with the membership version it was opened at");
  assert.equal(w.kernelMsgs().length, 1, "the kernel writes the reply when it closes");
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, delta: "the usual one." }, { thread });
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, done: true }, { thread });
  await w.idle();
  const reply = w.frames(chat.id).filter((/** @type {any} */ f) => f.author === "assistant:kit" && f.type.startsWith("session.text"));
  assert.equal(reply.at(-1).type, "session.text-done");
  assert.ok(reply.slice(0, -1).every((/** @type {any} */ f) => f.type === "session.text-delta"));
  assert.equal(reply.map((/** @type {any} */ f) => f.data.text || "").join(""), "The fee is the usual one.");
  assert.equal(reply[0].acts_for, `person:${BOB}`);
  const all = w.kernelMsgs();
  assert.equal(all.length, 2);
  assert.deepEqual(all[1].data.by, { person: BOB, agent: "kit" }, "an assistant's reply is written under its own session, for the person it acts for");
  assert.equal(all[1].data.chat, chat.id);
});

test("a reply the kernel refuses at open is shown nowhere (the assistant was removed before it spoke); one taken back mid-reply is cut where it is", async t => {
  const w = await world(t);
  const { chat, thread } = await asked(w);
  await w.C.change(w.chains.bob, chat.id, { remove_assistants: ["kit"] });
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, delta: "SECRET-PARTIAL " }, { thread });
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, delta: "more words" }, { thread });
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, done: true }, { thread });
  await w.idle();
  const log = JSON.stringify(w.frames(chat.id));
  assert.ok(!log.includes("SECRET-PARTIAL") && !log.includes("more words"), "nothing of the refused reply is in the log");
  assert.equal(w.frames(chat.id).filter((/** @type {any} */ f) => f.author === "assistant:kit").length, 0);
  assert.equal(w.kernelMsgs().length, 1, "the kernel wrote no reply");
  // and the live socket saw none of it either
  /** @type {any[]} */ const got = [];
  const c = connect({ open: async ({ from }) => { const o = ok(await w.as("bob")("stream.open", { session: chat.id, from })); return wsDuplex(`ws://127.0.0.1:${w.port}${o.path}`); }, onFrame: f => got.push(f), backoff: { base: 5, cap: 10 } });
  t.after(() => c.close());
  await tick(150);
  assert.ok(!JSON.stringify(got).includes("SECRET-PARTIAL"));
});

test("a reply the kernel takes back while it streams (the asker left the chat): the words already sent stay, then it is cut and the kernel wrote none", async t => {
  const w = await world(t);
  const { chat, thread } = await asked(w);
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, delta: "first words " }, { thread });
  await w.idle();
  await w.C.change(w.chains.bob, chat.id, { remove_people: [BOB] });
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, done: true }, { thread });
  await w.idle();
  const mine = w.frames(chat.id).filter((/** @type {any} */ f) => f.author === "assistant:kit");
  assert.ok(mine.some((/** @type {any} */ f) => f.type === "session.text-delta"), "what streamed before stays");
  assert.ok(mine.some((/** @type {any} */ f) => f.type === "session.text-cut"), "and it is cut");
  assert.ok(!mine.some((/** @type {any} */ f) => f.type === "session.text-done"));
  assert.equal(w.kernelMsgs().length, 1, "the kernel wrote no reply");
});

test("on the kernel's own appendOpen and mayReceive: a person who joins while a reply streams gets none of it (not even later deltas), sees the chat from their join, and gets the next reply; the one who was there got it all", async t => {
  const w = await world(t);
  const { chat, thread } = await asked(w);
  const live = (/** @type {string} */ who) => {
    /** @type {any[]} */ const got = [];
    const c = connect({ open: async ({ from }) => { const o = ok(await w.as(who)("stream.open", { session: chat.id, from })); return wsDuplex(`ws://127.0.0.1:${w.port}${o.path}`); }, onFrame: f => got.push(f), backoff: { base: 5, cap: 10 } });
    t.after(() => c.close());
    return got;
  };
  const carol = live("carol");
  await tick(100);
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, delta: "ONE-SECRET " }, { thread });
  await w.idle();
  await w.C.change(w.chains.bob, chat.id, { add_people: [ADA] });   // ada joins while kit is mid-reply
  const ada = live("ada");
  await tick(100);
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, delta: "TWO-SECRET" }, { thread });
  w.events.emit("threads", "thread.text", { message: "m1", block: 0, done: true }, { thread });
  await w.idle();
  ok(await w.as("bob")("stream.send", { session: chat.id, text: "and the retainer?", to: ["assistant:kit"], cwd: "/tmp", message: "q2" }));
  await w.idle();
  w.events.emit("threads", "thread.text", { message: "m2", block: 0, delta: "The retainer " }, { thread });
  w.events.emit("threads", "thread.text", { message: "m2", block: 0, delta: "is two thousand." }, { thread });
  w.events.emit("threads", "thread.text", { message: "m2", block: 0, done: true }, { thread });
  await w.idle();
  await tick(250);
  const text = (/** @type {any[]} */ g) => g.filter(f => f.type === "session.text-delta").map(f => f.data.text).join("");
  assert.equal(text(carol), "ONE-SECRET TWO-SECRETThe retainer is two thousand.", "carol was there for both replies, streamed");
  assert.ok(!JSON.stringify(ada).includes("SECRET"), "ada got no frame of the reply she joined during");
  assert.ok(!JSON.stringify(ada).includes("what is the fee"), "nor anything said before she joined");
  assert.equal(text(ada), "The retainer is two thousand.", "and the next reply in full");
  assert.ok(ada.some(f => f.type === "session.participant-joined" && f.data.who === `person:${ADA}` && !f.data.quiet), "her own join is the marker");
  const ids = new Set(w.frames(chat.id).filter((/** @type {any} */ f) => f.type === "session.text-delta" && f.author === "assistant:kit").map((/** @type {any} */ f) => f.data.rid));
  assert.equal(ids.size, 2, "each reply carries the kernel's id for it");
});

test("the token's chat is fixed: a turn in chat A cannot be redirected into chat B by anything the model emits", async t => {
  const w = await world(t);
  const a = await asked(w);
  const b = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  const aThread = a.thread;
  // the model names the other chat everywhere it can: in the text, in the block, in the data
  w.say(aThread, "m1", `reply for chat ${b.id}`, { chat: b.id, session: b.id, blocks: [{ block: "text", text: "x", chat: b.id }] });
  await w.idle();
  assert.equal(w.kernelMsgs().length, 2);
  assert.ok(w.kernelMsgs().every((/** @type {any} */ e) => e.data.chat === a.chat.id), "every message the kernel wrote is in chat A");
  assert.ok(w.frames(a.chat.id).some((/** @type {any} */ f) => f.type === "session.text-done"), "the reply is in A");
  assert.equal(w.frames(b.id).length, 0, "nothing reached B");
  // the kernel itself refuses the same attempt made directly under A's token
  const tok = (await w.k.surfaces.open(w.chains.bob, { chat: a.chat.id })).token;
  await assert.rejects(() => w.k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } }).chats.append(tok, { chat: b.id, body: "x" }), { code: "not_found" });
});

test("stream.send with a token cannot add a person or an assistant, listed or not; membership is the kernel's change by a person acting directly", async t => {
  const w = await world(t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  ok(await w.as("bob")("stream.send", { session: chat.id, text: "hello", to: [] }));
  const grp = w.stream().groups;
  const before = JSON.stringify([...grp.people(chat.id)].sort());
  for (const [what, input] of /** @type {[string, any][]} */ ([
    ["a person outside", { people: [`person:${ADA}`] }],
    ["an assistant outside", { assistants: [{ id: "assistant:juno", cwd: "/tmp" }] }],
    ["a listed assistant", { assistants: ["assistant:kit"] }],
    ["a listed person", { people: [`person:${CAROL}`] }],
    ["a model", { assistants: ["model:x"] }],
  ])) {
    assert.equal(codeOf(await w.as("bob")("stream.send", { session: chat.id, text: `add ${what}`, to: [], ...input })), "bad_input", what);
  }
  assert.equal(JSON.stringify([...grp.people(chat.id)].sort()), before);
  assert.deepEqual(w.C.read(w.chains.bob, chat.id).assistants, ["kit"], "the kernel's list did not move");
  assert.deepEqual([...w.C.read(w.chains.bob, chat.id).people].sort(), [BOB, CAROL]);
  assert.equal(w.kernelMsgs().length, 1, "only the first send reached the kernel");
  // an assistant's own session cannot change the list either (the kernel refuses it)
  const kitTok = (await w.k.surfaces.open(w.chains.bob, { chat: chat.id, agent: "kit" })).token;
  const kitChain = await w.k.kernelFor({ name: "x", needs: {} }).chain({ token: kitTok });
  await assert.rejects(() => w.C.change(kitChain, chat.id, { add_people: [ADA] }), e => ["chain_not_person", "not_found"].includes(/** @type {any} */ (e).code));
  // a person acting directly changes it, and the stream follows the kernel
  await w.C.change(w.chains.bob, chat.id, { add_people: [ADA], add_assistants: ["juno"] });
  ok(await w.as("ada")("stream.send", { session: chat.id, text: "now me", to: [] }));
  assert.ok(grp.people(chat.id).has(`person:${ADA}`));
  assert.ok(w.frames(chat.id).some((/** @type {any} */ f) => f.type === "session.participant-joined" && f.data.who === "assistant:juno"), "a listed assistant is mirrored into the group");
  await w.C.change(w.chains.bob, chat.id, { remove_assistants: ["juno"] });
  ok(await w.as("bob")("stream.send", { session: chat.id, text: "bye juno", to: [] }));
  assert.ok(w.frames(chat.id).some((/** @type {any} */ f) => f.type === "session.participant-left" && f.data.who === "assistant:juno"));
});

test("an unlisted assistant is refused: it cannot read or speak in a chat that does not list it, and a call with no session is not a chat call", async t => {
  const w = await world(t);
  const chat = await w.C.create(w.chains.ada, { people: [], assistants: [] });
  assert.equal(codeOf(await w.as("adaKit")("stream.open", { session: chat.id })), "not_found", "ada's assistant is not listed in ada's chat");
  assert.equal(codeOf(await w.as("adaKit")("stream.send", { session: chat.id, text: "hi", to: [] })), "not_found");
  const listed = await w.C.create(w.chains.ada, { assistants: ["kit"] });
  assert.equal(codeOf(await w.as("adaKit")("stream.open", { session: listed.id })), "ok", "listed, for the person it acts for, who is in the chat");
  // the kernel's kernel-side: an assistant session for an unlisted agent cannot append
  const tok = (await w.k.surfaces.open(w.chains.ada, { chat: chat.id, agent: "kit" })).token;
  await assert.rejects(() => w.k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } }).chats.append(tok, { body: "x" }), { code: "not_found" });
  // kernel on, no session token on the call: the 0.2 group path is closed
  const r = await w.reg.call("stream.send", { session: chat.id, text: "hi", to: [] }, "deck", {});
  assert.equal(codeOf(r), "person_session_required");
  const o = await w.reg.call("stream.open", { session: chat.id }, "deck", {});
  assert.equal(codeOf(o), "not_found");
});

test("a person's words the kernel refuses are not stored: the sender left the chat between the open and the send", async t => {
  const w = await world(t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL] });
  ok(await w.as("carol")("stream.send", { session: chat.id, text: "first", to: [] }));
  await w.C.change(w.chains.bob, chat.id, { remove_people: [CAROL] });
  assert.equal(codeOf(await w.as("carol")("stream.send", { session: chat.id, text: "after leaving", to: [] })), "not_found");
  assert.ok(!JSON.stringify(w.frames(chat.id)).includes("after leaving"));
  assert.equal(w.kernelMsgs().length, 1);
});

test("a retry of the same message id while the first is still being written is one message", async t => {
  const w = await world(t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL] });
  const [a, b] = await Promise.all([1, 2].map(() => w.as("bob")("stream.send", { session: chat.id, text: "once", to: [], message: "m_once" })));
  ok(a); ok(b);
  assert.equal(w.frames(chat.id).filter((/** @type {any} */ f) => f.type === "session.user-message").length, 1);
  assert.equal(w.kernelMsgs().length, 1, "the kernel was asked once");
});

const FEE = { block: "field", name: "fee", label: "Fee", kind: "money", value: { amount: 4200, currency: "USD" } };
/** Make kit's next thread event come out as exactly these specs (the adapter itself never builds a field block today). */
const stand = (/** @type {any} */ w, /** @type {string} */ chat) => { const m = w.stream().groups.member(chat, "assistant:kit"); m.ad = { event: () => [{ kind: "text-delta", data: { message: "mx", index: 0, text: "The fee is on the card." } }, { kind: "text-done", data: { message: "mx", blocks: [{ block: "text", text: "see below" }, FEE] } }] }; };

test("a room of more than one person: an assistant's field value is dropped (against the kernel's own room view); in a chat of one it stays", async t => {
  const w = await world(t);
  const R = w.k.gateway.records;
  await R.define(w.chains.owner, { add_types: [CONTACT] });
  const rec = await R.create(w.chains.owner, "contact", { name: "Jane", fee: { amount: 4200, currency: "USD" }, ssn: { sealed: "ssn", ref: "sv_1", present: true, valid_format: true, set_at: 1 } });
  const urn = `vyre://${SPACE}/contact/${rec.id}`;
  const room = await asked(w);
  stand(w, room.chat.id);
  w.events.emit("threads", "thread.text", { message: "go" }, { thread: room.thread });
  await w.idle();
  const f = w.frames(room.chat.id);
  assert.ok(f.some((/** @type {any} */ x) => x.type === "session.text-done" && x.author === "assistant:kit"), "the reply itself is shown");
  assert.ok(!JSON.stringify(f).includes("4200"), "no field value reached the group's log");
  assert.deepEqual(f.find((/** @type {any} */ x) => x.type === "session.text-done").data.blocks, [{ block: "text", text: "see below" }]);
  // the kernel's room view for the same chat: more than one person, and a sealed field is never a value for the room
  const tok = (await w.k.surfaces.open(w.chains.bob, { chat: room.chat.id })).token;
  w.k.bindCalls(() => ({ token: tok }));
  const view = await w.k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } }).audienceFor();
  w.k.bindCalls(currentCall);
  assert.equal(view.group, true, "the kernel agrees this is a room");
  const seen = await view.read(urn, ["ssn"]);
  assert.ok(seen === null || seen.restricted.includes("ssn"), "a sealed field is never a value for the room");
  // one person and an assistant: the same reply keeps the card
  const solo = await w.C.create(w.chains.bob, { assistants: ["kit"] });
  ok(await w.as("bob")("stream.send", { session: solo.id, text: "fee?", to: ["assistant:kit"], cwd: "/tmp" }));
  await w.idle();
  const th2 = w.threads().started.at(-1).id;
  stand(w, solo.id);
  w.events.emit("threads", "thread.text", { message: "go" }, { thread: th2 });
  await w.idle();
  const solo1 = w.frames(solo.id).find((/** @type {any} */ x) => x.type === "session.text-done");
  assert.deepEqual(solo1.data.blocks.map((/** @type {any} */ b) => b.block), ["text", "field"]);
});

test("a cited field is the kernel's own records.get for the viewer: a value, the sealed chip with no ref, a chip for a field the kernel hides or that does not exist", async t => {
  const w = await world(t);
  const R = w.k.gateway.records;
  await R.define(w.chains.owner, { add_types: [CONTACT] });
  const rec = await R.create(w.chains.owner, "contact", { name: "Jane", fee: { amount: 4200, currency: "USD" }, ssn: { sealed: "ssn", ref: "sv_SECRET", present: true, valid_format: true, set_at: 1, hint: "6789" } });
  const urn = `vyre://${SPACE}/contact/${rec.id}`;
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  ok(await w.as("bob")("stream.send", { session: chat.id, text: "go", to: [] }));
  const log = w.stream().logs.get(chat.id);
  const cite = (/** @type {string} */ field) => ({ block: "field-ref", record: urn, field, label: field });
  log.append("text-done", { message: "m9", blocks: [cite("name"), cite("fee"), cite("ssn"), cite("nonesuch"), { block: "field-ref", record: `vyre://${SPACE}/contact/nonexistent`, field: "name", label: "gone" }] }, { author: "assistant:kit", acts_for: `person:${BOB}`, message: "m9" });
  /** @type {any[]} */ const got = [];
  const c = connect({ open: async ({ from }) => { const o = ok(await w.as("bob")("stream.open", { session: chat.id, from })); return wsDuplex(`ws://127.0.0.1:${w.port}${o.path}`); }, onFrame: f => got.push(f), backoff: { base: 5, cap: 10 } });
  t.after(() => c.close());
  const end = Date.now() + 5000;
  while (!got.some(f => f.type === "session.text-done" && f.data.message === "m9") && Date.now() < end) await tick(10);
  const blocks = got.find(f => f.type === "session.text-done" && f.data.message === "m9").data.blocks;
  const wire = JSON.stringify(got);
  assert.ok(!wire.includes("sv_SECRET") && !wire.includes("6789"), "a sealed value or its ref never reaches the wire");
  const by = (/** @type {string} */ n) => blocks.find((/** @type {any} */ b) => b.name === n);
  // every block is a field block, never a ref and never a leak
  assert.ok(blocks.every((/** @type {any} */ b) => b.block === "field"));
  assert.equal(by("ssn").placeholder, true);
  assert.equal(by("nonesuch").placeholder, true);
  assert.equal(blocks[4].placeholder, true, "a record the kernel does not return is a chip");
  assert.equal(by("name").value, "Jane", "bob's own authority gave the value");
  assert.deepEqual(by("fee").value, { amount: 4200, currency: "USD" });
  assert.equal(by("fee").kind, "money");
  assert.equal(by("ssn").kind, "sealed");
});

test("after a restart the assistant has no session token: its reply waits, shows nothing, and is written when the asker next opens the chat", async t => {
  const w = await world(t);
  const { chat, thread } = await asked(w);
  const m = w.stream().groups.member(chat.id, "assistant:kit");
  m.tokens = new Map(); // what a restart forgets
  w.say(thread, "m1", "waiting for you");
  await tick(80); // not idle(): the assistant's queue is waiting for a session, on purpose
  assert.equal(w.frames(chat.id).filter((/** @type {any} */ f) => f.author === "assistant:kit").length, 0, "nothing is shown without a kernel session");
  assert.equal(w.kernelMsgs().length, 1);
  ok(await w.as("bob")("stream.open", { session: chat.id }));
  await tick(50);
  await w.idle();
  assert.ok(w.frames(chat.id).some((/** @type {any} */ f) => f.type === "session.text-done" && f.author === "assistant:kit"));
  assert.equal(w.kernelMsgs().length, 2);
});
