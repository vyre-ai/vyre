// @ts-check
// Step 7 of the E2E run, as far as it can run without a switchboard that carries the chat (chat 0.3 task S). What is REAL here: the kernel (createKernel: surfaces, chats, the room
// with beginTurn/appendOpen/mayReceive), lib/kernel-session.js (createKernelSessions with chats: the kernel's chats and a durable turns store), the stream module and its group
// chats, the module registry that hands the stream the seam the way the daemon does (deps.kernelThreads -> ctx.kernelSession), and real websockets for the viewers. What is a RIG:
// the threads module (a first-party stand-in for the switchboard: threads.start/send/get), and "vyred opens the thread's session from the person's own send", which the real
// switchboard cannot do yet (threads.start has no chat and no asker; see docs/work/chat.md Needs), so the stand-in calls ks.open({ chain, chat, agent, thread }) at the send. The
// assistant is a scripted one: its words arrive as the switchboard's own thread events, no provider is called. Not a vyred process, so this is the stream on the seam, not a daemon.
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
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { createKernelSessions } from "../../lib/kernel-session.js";
import { connect, wsDuplex } from "./client.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada";
const used = new Set();
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await sleep(10); } throw new Error(`timed out waiting for ${what}`); };

/** The threads stand-in: a first-party module whose start and send hand the rig the call (vyred's side: open the session) and answer a thread id. */
function fakeThreadsWithSend(/** @type {string} */ dir) {
  const d = path.join(dir, "threads");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "module.json"), JSON.stringify({ name: "threads", version: "0.0.0", roles: ["box", "local"], requires: [],
    does: { tools: [{ name: "threads.get", reach: "anyone" }, { name: "threads.start", reach: "anyone" }, { name: "threads.send", reach: "anyone" }] }, watches: { emits: [] }, shows: {}, needs: {}, teaches: { tips: [] }, settings: [] }));
  const callers = JSON.stringify(["cli", "local", "deck", "capsule", "tailnet", "mcp", "harness", "module"]);
  fs.writeFileSync(path.join(d, "index.js"), `
const obj = (p) => ({ type: "object", properties: p });
export default { async start(ctx) {
  const hook = async (tool, i, meta) => { const h = globalThis.__threadsHook; return h ? h(tool, i, meta) : undefined; };
  ctx.tool("threads.get", { description: "fake", input: obj({ thread: { type: "string" }, limit: { type: "integer" } }), callers: ${callers}, run: async () => ({ thread: {}, events: [] }) });
  ctx.tool("threads.start", { description: "fake", input: obj({ cwd: { type: "string" }, prompt: { type: "string" }, surface: { type: "string" } }), callers: ${callers}, run: async (i, meta) => ({ id: await hook("start", i, meta) }) });
  ctx.tool("threads.send", { description: "fake", input: obj({ thread: { type: "string" }, text: { type: "string" }, surface: { type: "string" }, uuid: { type: "string" } }), callers: ${callers}, run: async (i, meta) => { await hook("send", i, meta); return { ok: true }; } });
  return {};
} };
`);
}

/** Everything that survives a daemon restart (the kernel and its sessions' turn store, the stream's own database and home) and the stream side that does not. */
async function world(t) {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "manager"], [CAROL, "member"], [ADA, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const dev = (/** @type {string} */ person, /** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const chains = { bob: dev(BOB, "d-b"), carol: dev(CAROL, "d-c"), ada: dev(ADA, "d-a") };
  /** @type {Record<string, string>} */ const tokens = {};
  for (const [n, c] of Object.entries(chains)) tokens[n] = (await k.surfaces.open(c, {})).token;
  const direct = new Map(Object.entries(tokens).map(([n, tok]) => [tok, /** @type {any} */ (chains)[n]]));
  const kernelFor = (/** @type {any} */ m) => { const h = k.kernelFor(m); return Object.freeze({ ...h, chain: async (/** @type {any} */ meta) => (meta && direct.get(meta.token)) || h.chain(meta) }); };
  // the open turns, kept as the daemon keeps them: durable across the stream's restart
  /** @type {Map<string, any>} */ const kept = new Map();
  const turns = { durable: true, get: (/** @type {string} */ x) => kept.get(x), set: (/** @type {string} */ x, /** @type {any} */ r) => kept.set(x, r), delete: (/** @type {string} */ x) => kept.delete(x), all: () => /** @type {[string, any][]} */ ([...kept]) };
  const p = config.ensure(tempHome(t));
  const fake = fs.mkdtempSync(path.join(SCRATCH, "vyre-stream-ks-"));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  fakeThreadsWithSend(fake);
  const personChainFor = async (/** @type {string} */ person) => k.chains.fromFacts({ kind: "device", device_key_id: "vyred", person, path: "direct" });
  /** @type {any[]} */ const gaveUp = [];
  let n = 0;
  /** @type {Map<string, string>} */ const chatOf = new Map();
  /** @type {Set<string>} */ const opened = new Set();
  const rig = { chat: "", asker: "bob" };

  /** Start the stream the way the daemon does: the Registry is handed the seam as deps.kernelThreads, over a createKernelSessions that has the kernel's chats and the durable turns. */
  async function boot(/** @type {{ personChainFor?: (p: string) => Promise<any>, timeoutMs?: number }} */ o = {}) {
    const ks = createKernelSessions({ kernel: k, turns, chats: /** @type {any} */ (k.kernelFor({ name: "kernel-sessions" })).chats });
    const db = open(p.db);
    const events = new Events(db);
    const reg = new Registry({ db, events, config: { role: "box", stream: { resumeWaitSeconds: o.timeoutMs ? o.timeoutMs / 1000 : 60 } }, paths: p, log: () => {}, kernelFor });
    reg.deps.kernelThreads = Object.freeze({
      forThread: (/** @type {string} */ thread) => ks.forThread(thread),
      reopenPending: (/** @type {any} */ a) => ks.reopenPending({ personChainFor: o.personChainFor || personChainFor, ...a }),
    });
    /** vyred's side of a person's send: it opens the thread's session from the person's own chain, the chat and the assistant. @type {any} */
    const hook = async (/** @type {string} */ tool, /** @type {any} */ i) => {
      const thread = tool === "start" ? `thr_${++n}` : String(i.thread);
      if (!chatOf.has(thread)) chatOf.set(thread, rig.chat);
      if (!opened.has(thread)) { opened.add(thread); await ks.open({ chain: await personChainFor(`per_${rig.asker}`), chat: /** @type {string} */ (chatOf.get(thread)), agent: "kit", thread }); }
      return thread;
    };
    /** @type {any} */ (globalThis).__threadsHook = hook;
    await reg.start([...discover([CORE]).filter(f => f.manifest && f.manifest.name === "stream"), ...discover([fake], { firstPartyRoots: [fake] })], { role: "box" });
    assert.equal(reg.modules.get("stream")?.state, "running", reg.modules.get("stream")?.error);
    const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
    s.on("upgrade", (req, socket, head) => { reg.upgrades.get("stream/session").handler(req, socket, head, { caller: "deck", url: new URL(req.url || "/", "http://vyred") }); });
    await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
    const port = /** @type {any} */ (s.address()).port;
    const as = (/** @type {string} */ who) => (/** @type {string} */ tool, /** @type {any} */ input) => reg.call(tool, input, "deck", { token: tokens[who] });
    const stop = async () => { s.closeAllConnections(); s.close(); await reg.stop(); db.close(); };
    const watch = async (/** @type {string} */ who, /** @type {string} */ session) => {
      /** @type {any[]} */ const frames = [];
      const c = connect({ open: async ({ from }) => { const r = await as(who)("stream.open", { session, from }); assert.ok(!r.error, r.error && r.error.message); return wsDuplex(`ws://127.0.0.1:${port}${r.data.path}`); }, onFrame: f => frames.push(f), backoff: { base: 5, cap: 10 } });
      t.after(() => c.close());
      return { frames, close: () => c.close() };
    };
    return { ks, reg, as, port, stop, watch, stream: () => reg.modules.get("stream")?.handle, events };
  }
  return { k, chains, tokens, kept, boot, gaveUp, rig, C: g.chats, say: (/** @type {any} */ b, /** @type {string} */ thread, /** @type {string} */ message, /** @type {any} */ x) => b.events.emit("switchboard", "thread.text", { message, block: 0, ...x }, { thread }) };
}
const textOf = (/** @type {any[]} */ frames) => frames.filter(f => f.type === "session.text-delta" && !f.data.reasoning).map(f => f.data.text).join("");
const kitThread = (/** @type {any} */ b, /** @type {string} */ chat) => String(b.stream().groups.member(chat, "assistant:kit").thread);

test("a person sends, the assistant's reply streams through the seam's handle, and a person who joined mid-reply does not receive it", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  w.rig.chat = chat.id; w.rig.asker = "bob";
  const bob = await b.watch("bob", chat.id);
  const sent = await b.as("bob")("stream.send", { session: chat.id, text: "what is the fee?", to: ["assistant:kit"], cwd: "/tmp" });
  assert.ok(!sent.error, sent.error && `${sent.error.code} ${sent.error.message}`);
  await until(() => b.stream().groups.member(chat.id, "assistant:kit")?.thread, "the thread");
  const kit = kitThread(b, chat.id);
  assert.deepEqual(b.ks.list().length, 1, "vyred holds one kernel session, for the assistant's thread");
  w.say(b, kit, "m1", { delta: "SECRET one " });
  await until(() => textOf(bob.frames).includes("SECRET one"), "the first delta");
  await w.C.change(w.chains.bob, chat.id, { add_people: [ADA] });
  const ada = await b.watch("ada", chat.id);
  w.say(b, kit, "m1", { delta: "SECRET two" });
  w.say(b, kit, "m1", { done: true });
  await until(() => bob.frames.some(f => f.type === "session.text-done"), "the reply to finish");
  assert.equal(textOf(bob.frames), "SECRET one SECRET two", "bob got it as it streamed");
  await sleep(100);
  assert.ok(!JSON.stringify(ada.frames).includes("SECRET"), "ada, who joined mid-reply, got none of it");
  const kernelLog = w.k.log.read({}).filter((/** @type {any} */ e) => e.type === "message.opened" || e.type === "message.added");
  assert.ok(kernelLog.some((/** @type {any} */ e) => e.type === "message.opened" && e.data.by.agent === "kit"), "the kernel recorded the assistant's reply, opened under the assistant's own session");
  await b.stop();
});

/** boot() with a stopper registered for the test. @param {any} w @param {any} t */
async function world0(w, t) { const b = await w.boot(); t.after(() => b.stop().catch(() => {})); return b; }

test("a restart in the middle of a turn: the seam reopens the person's session and the reply goes on", async t => {
  const w = await world(t);
  const b1 = await w.boot();
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  w.rig.chat = chat.id; w.rig.asker = "bob";
  const sent = await b1.as("bob")("stream.send", { session: chat.id, text: "go", to: ["assistant:kit"], cwd: "/tmp" });
  assert.ok(!sent.error, sent.error && sent.error.message);
  await until(() => b1.stream().groups.member(chat.id, "assistant:kit")?.thread, "the thread");
  const kit = kitThread(b1, chat.id);
  assert.equal(w.kept.has(kit), true, "the open turn is kept (the person, the chat, the assistant; never a token)");
  assert.ok(!JSON.stringify([...w.kept.values()]).includes("token"));
  w.say(b1, kit, "m1", { delta: "before " });
  await sleep(150);
  await b1.stop(); // the daemon stops mid-turn: the seam's sessions are gone with it, the kept turn is not
  const b2 = await w.boot();
  t.after(() => b2.stop().catch(() => {}));
  const bob = await b2.watch("bob", chat.id);
  await until(() => b2.ks.list().length === 1, "the session to be reopened by reopenPending");
  w.say(b2, kit, "m1", { delta: "after the restart" });
  w.say(b2, kit, "m1", { done: true });
  await until(() => bob.frames.some(f => f.type === "session.text-done"), "the reply to finish after the restart");
  assert.match(textOf(bob.frames), /after the restart/);
  assert.ok(!bob.frames.some(f => f.type === "session.status" && f.data.state === "failed"), "nothing says it could not resume");
});

test("a restart where the person can no longer be reopened: the turn is given up, the room is told, and the reply is dropped", async t => {
  const w = await world(t);
  const b1 = await w.boot();
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  w.rig.chat = chat.id; w.rig.asker = "bob";
  const sent = await b1.as("bob")("stream.send", { session: chat.id, text: "go", to: ["assistant:kit"], cwd: "/tmp" });
  assert.ok(!sent.error, sent.error && sent.error.message);
  await until(() => b1.stream().groups.member(chat.id, "assistant:kit")?.thread, "the thread");
  const kit = kitThread(b1, chat.id);
  await b1.stop();
  const b2 = await w.boot({ personChainFor: async () => { throw Object.assign(new Error("no longer a member"), { code: "not_found" }); } });
  t.after(() => b2.stop().catch(() => {}));
  const bob = await b2.watch("bob", chat.id);
  await until(() => bob.frames.some(f => f.type === "session.status" && f.data.state === "failed"), "the give-up to show");
  assert.match(String(bob.frames.find(f => f.type === "session.status" && f.data.state === "failed").data.note), /couldn't resume, ask again/);
  assert.equal(w.kept.has(kit), false, "the given-up turn is forgotten");
  w.say(b2, kit, "m1", { delta: "never shown" });
  w.say(b2, kit, "m1", { done: true });
  await sleep(200);
  assert.ok(!JSON.stringify(bob.frames).includes("never shown"));
});
