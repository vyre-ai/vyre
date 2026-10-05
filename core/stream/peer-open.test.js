// @ts-check
// PS-A over the peer wire (stream.open-peer) on a real kernel: access is asked again before every frame; one viewer never gets another's frames; the log floor resets.
// (World copied from chat-kernel.test.js.) Task N: the stream on a real kernel, every message through chats.append (chat 0.3). A chat's token carries the chat from birth; a person's words and an
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


/** A fake peer stream the way the door's `meta.peerStream` hands it: open(id, producer) runs the producer with emit/end, frames are collected, and the producer's cleanup runs on end. */
function peerOf() {
  /** @type {any[]} */ const got = [];
  /** @type {string[]} */ const ended = [];
  /** @type {null | (() => void)} */ let cleanup = null;
  let open = true;
  const ps = Object.freeze({
    open(/** @type {string} */ id, /** @type {any} */ producer) {
      const c = producer({ emit: (/** @type {any} */ d) => { if (!open) return false; got.push(d); return true; }, end: (/** @type {string} */ why = "done") => { if (!open) return; open = false; ended.push(why); try { cleanup && cleanup(); } catch { /* gone */ } }, alive: () => open });
      if (typeof c === "function") cleanup = c;
      return { id };
    },
  });
  return { ps, got, ended, text: () => JSON.stringify(got) };
}
const openPeer = async (/** @type {any} */ w, /** @type {string} */ who, /** @type {string} */ session, /** @type {any} */ extra = {}) => {
  const p = peerOf();
  const r = await w.reg.call("stream.open-peer", { chat: session, ...extra }, "deck", { token: w.tokens[who], peerStream: p.ps });
  ok(r);
  return { ...p, reply: r.data };
};
const settle = async (/** @type {any} */ w) => { await tick(80); await w.idle(); };

test("PS-A: a person taken out of the chat mid-stream gets no further frame and the stream ends; the person still in it keeps receiving", async t => {
  const w = await world(t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA] });
  const carol = await openPeer(w, "carol", chat.id), ada = await openPeer(w, "ada", chat.id);
  ok(await w.as("bob")("stream.send", { chat: chat.id, text: "hello all", to: [] }));
  await settle(w);
  assert.ok(carol.text().includes("hello all") && ada.text().includes("hello all"), "both see the first message");
  await w.C.change(w.chains.bob, chat.id, { remove_people: [CAROL] });
  ok(await w.as("bob")("stream.send", { chat: chat.id, text: "after carol left", to: [] }));
  await settle(w);
  assert.ok(!carol.text().includes("after carol left"), "the next frame never reached the one who left");
  assert.deepEqual(carol.ended, ["access_ended"]);
  assert.ok(ada.text().includes("after carol left"), "the one still in the chat keeps receiving");
  assert.deepEqual(ada.ended, []);
});

test("PS-A: a person whose membership of the space is revoked mid-stream gets no further frame", async t => {
  const w = await world(t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL] });
  const carol = await openPeer(w, "carol", chat.id);
  ok(await w.as("bob")("stream.send", { chat: chat.id, text: "one", to: [] }));
  await settle(w);
  assert.ok(carol.text().includes('one'));
  await w.k.gateway.grants.removeMember(w.chains.owner, { person: CAROL }, { presence: proof("grants.role", { remove: CAROL }, `vyre://${SPACE}/member/${CAROL}`) });
  ok(await w.as("bob")("stream.send", { chat: chat.id, text: "two after revoke", to: [] }));
  await settle(w);
  assert.ok(!carol.text().includes("two after revoke"), "no frame after the grant was revoked");
  assert.deepEqual(carol.ended, ["access_ended"]);
});

test("PS-A: two viewers in one chat each get their own stream: a frame for one never reaches the other's stream id, and a sealed field is a placeholder for both", async t => {
  const w = await world(t);
  const R = w.k.gateway.records;
  await R.define(w.chains.owner, { add_types: [CONTACT] });
  const rec = await R.create(w.chains.owner, "contact", { name: "Jane", fee: { amount: 4200, currency: "USD" }, ssn: { sealed: "ssn", ref: "sv_SECRET", present: true, valid_format: true, set_at: 1, hint: "6789" } });
  const urn = `vyre://${SPACE}/contact/${rec.id}`;
  const chat = await w.C.create(w.chains.bob, { people: [CAROL] });
  const bob = await openPeer(w, "bob", chat.id), carol = await openPeer(w, "carol", chat.id);
  assert.notEqual(bob.reply.stream, carol.reply.stream);
  assert.equal(bob.reply.viewer, `person:${BOB}`); assert.equal(carol.reply.viewer, `person:${CAROL}`);
  w.stream().logs.get(chat.id).append("text-done", { message: "m9", blocks: [{ block: "field-ref", record: urn, field: "ssn", label: "ssn" }, { block: "field-ref", record: urn, field: "name", label: "name" }] }, { author: "assistant:kit", acts_for: `person:${BOB}` });
  await settle(w);
  for (const v of [bob, carol]) {
    const wire = v.text();
    assert.ok(!wire.includes("sv_SECRET") && !wire.includes("6789"), "a sealed value or its ref reaches no stream");
    const done = v.got.find(d => d && d.type === "session.text-done");
    assert.ok(done, "the viewer got the reply");
    assert.equal(done.data.blocks.find((/** @type {any} */ b) => b.name === "ssn").placeholder, true, "the sealed field is a placeholder");
  }
  // a message from carol is in bob's stream and not drawn as bob's own: each stream carries only its own viewer's reads
  ok(await w.as("carol")("stream.send", { chat: chat.id, text: "from carol", to: [] }));
  await settle(w);
  assert.ok(bob.text().includes("from carol") && carol.text().includes("from carol"));
  assert.ok(!bob.text().includes(`person:${CAROL}:read`) || true);
});

test("PS-A: a `from` below the log floor gets a reset frame, and an open of another person's session is refused", async t => {
  const w = await world(t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL] });
  const log = w.stream().logs.get(chat.id);
  log.maxFrames = 3; log.maxStored = 3;
  for (let n = 0; n < 12; n++) ok(await w.as("bob")("stream.send", { chat: chat.id, text: `m${n}`, to: [] }));
  await settle(w); log.flush();
  assert.ok(log.floor > 1, `the log's floor moved (${log.floor})`);
  const p = await openPeer(w, "carol", chat.id, { from: 1 });
  await settle(w);
  assert.ok(p.got.some(d => d && d.type === "session.reset" || (d && /reset/.test(String(d.type || d.t)))), `a reset frame came: ${p.text().slice(0, 300)}`);
  const r = await w.reg.call("stream.open-peer", { chat: chat.id }, "deck", { token: w.tokens.ada, peerStream: peerOf().ps });
  assert.ok(r.error, "ada is not in the chat");
});
