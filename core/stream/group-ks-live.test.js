// @ts-check
// Step 7 of the E2E run, as far as it can run without a switchboard that carries the chat (chat 0.3 tasks S and T). What is REAL here: the kernel (createKernel: surfaces, chats, the room
// with beginTurn/appendOpen/mayReceive), lib/kernel-session.js (createKernelSessions with chats: the kernel's chats and a durable turns store), the stream module and its group
// chats, the REAL Switchboard (core/switchboard, the module named threads: threads.start/send/get, its own database, its own thread events) running the fake claude
// (core/switchboard/testing/fake-claude.js) as a real child process, the module registry that hands the stream the seam the way the daemon does (deps.kernelThreads ->
// ctx.kernelSession), and real websockets for the viewers. The assistant's words are the fake claude's own stream-json deltas, translated by the Switchboard into thread.text events.
// What is still a RIG, and the only thing: "vyred opens the thread's kernel session from the person's own send". The real Switchboard cannot do it yet (threads.start and threads.send
// carry no chat and no asker, and no thread record has `rec.chat`; see docs/work/chat.md Needs), so the rig wraps the registry's call for the stream's threads.start and threads.send and
// calls ks.open({ chain, chat, agent, thread }) when the Switchboard has answered, which is where the daemon's deps.kernelSession would run. Not a vyred process, so this is the
// stream on the seam, not a daemon.
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
import { FAKE } from "../sessions/testing/boot.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada";
const used = new Set();
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await sleep(10); } throw new Error(`timed out waiting for ${what}`); };

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
  // the real Switchboard runs the fake claude as a child process: the CLI driver, no sandbox, no thread socket, no spawner, a folder of its own to work in
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-stream-ks-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, VYRE_SESSIONS_THREAD_SOCKET: process.env.VYRE_SESSIONS_THREAD_SOCKET, VYRE_SESSIONS_SPAWNER: process.env.VYRE_SESSIONS_SPAWNER };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSIONS_THREAD_SOCKET: "off", VYRE_SESSIONS_SPAWNER: "off" });
  t.after(() => { for (const [k2, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k2]; else process.env[k2] = v; } });
  const personChainFor = async (/** @type {string} */ person) => k.chains.fromFacts({ kind: "device", device_key_id: "vyred", person, path: "direct" });
  /** @type {any[]} */ const gaveUp = [];
  const rig = { chat: "", asker: "bob" };
  /** What the stream asked of the seam, in order, per thread: beginTurn must come before the first appendOpen. @type {string[]} */ const seamCalls = [];

  /** Start the stream the way the daemon does: the Registry is handed the seam as deps.kernelThreads, over a createKernelSessions that has the kernel's chats and the durable turns. */
  async function boot(/** @type {{ personChainFor?: (p: string) => Promise<any>, timeoutMs?: number }} */ o = {}) {
    const ks = createKernelSessions({ kernel: k, turns, chats: /** @type {any} */ (k.kernelFor({ name: "kernel-sessions" })).chats });
    const db = open(p.db);
    const events = new Events(db);
    const reg = new Registry({ db, events, config: { role: "box", stream: { resumeWaitSeconds: o.timeoutMs ? o.timeoutMs / 1000 : 60 }, sessions: { install: false }, transcripts: [] }, paths: p, log: () => {}, kernelFor });
    reg.deps.kernelThreads = Object.freeze({
      forThread: (/** @type {string} */ thread) => {
        const s = ks.forThread(thread);
        return Object.freeze({ ...s, beginTurn: async () => { seamCalls.push(`${thread}:beginTurn`); return s.beginTurn(); }, appendOpen: async (/** @type {any} */ m) => { seamCalls.push(`${thread}:appendOpen`); return s.appendOpen(m); } });
      },
      reopenPending: (/** @type {any} */ a) => ks.reopenPending({ personChainFor: o.personChainFor || personChainFor, ...a }),
    });
    // The one stand-in. vyred's side of a person's send, which the Switchboard cannot carry yet: once the real Switchboard has answered the stream's threads.start or threads.send,
    // open the thread's kernel session from the person's own chain, the chat and the assistant. A thread whose open turn the seam already holds (reopened) is left alone.
    const realCall = reg.call.bind(reg);
    /** @type {any} */ (reg).call = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => {
      const r = await realCall(tool, input, caller, meta);
      if (r.error || caller !== "module:stream" || (tool !== "threads.start" && tool !== "threads.send")) return r;
      const thread = String(tool === "threads.start" ? r.data.id : input.thread);
      if (!turns.get(thread)) await ks.open({ chain: await personChainFor(`per_${rig.asker}`), chat: rig.chat, agent: "kit", thread });
      return r;
    };
    await reg.start(discover([CORE]).filter(f => f.manifest && (["stream", "threads", "sessions"].includes(f.manifest.name))), { role: "box" });
    for (const m of ["sessions", "threads", "stream"]) assert.equal(reg.modules.get(m)?.state, "running", reg.modules.get(m)?.error);
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
    return { ks, reg, realCall, as, port, stop, watch, stream: () => reg.modules.get("stream")?.handle, events };
  }
  return { k, chains, tokens, kept, boot, gaveUp, rig, work, seamCalls, C: g.chats };
}
const textOf = (/** @type {any[]} */ frames) => frames.filter(f => f.type === "session.text-delta" && !f.data.reasoning).map(f => f.data.text).join("");
const kitThread = (/** @type {any} */ b, /** @type {string} */ chat) => String(b.stream().groups.member(chat, "assistant:kit").thread);

const LONG = "SECRET " + Array(500).fill("word").join(" "); // the fake claude says it back in six-character deltas, a few milliseconds apart: a reply that is still arriving for a couple of seconds

test("a person sends, the real Switchboard's reply streams through the seam's handle, beginTurn comes first, and a person who joined mid-reply does not receive it", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  w.rig.chat = chat.id; w.rig.asker = "bob";
  const bob = await b.watch("bob", chat.id);
  const sent = await b.as("bob")("stream.send", { session: chat.id, text: LONG, to: ["assistant:kit"], cwd: w.work });
  assert.ok(!sent.error, sent.error && `${sent.error.code} ${sent.error.message}`);
  await until(() => b.stream().groups.member(chat.id, "assistant:kit")?.thread, "the thread");
  const kit = kitThread(b, chat.id);
  assert.deepEqual(b.ks.list().length, 1, "vyred holds one kernel session, for the assistant's thread");
  assert.ok((await b.reg.call("threads.get", { thread: kit, limit: 5 }, "cli")).data.thread, "the thread is the real Switchboard's own record");
  await until(() => textOf(bob.frames).includes("SECRET"), "the first delta");
  assert.ok(!bob.frames.some(f => f.type === "session.text-done"), "the reply is still arriving");
  await w.C.change(w.chains.bob, chat.id, { add_people: [ADA] });
  const ada = await b.watch("ada", chat.id);
  await until(() => bob.frames.some(f => f.type === "session.text-done"), "the reply to finish", 20_000);
  assert.equal(textOf(bob.frames), `echo: ${LONG}`, "bob got the fake claude's own words, as they streamed");
  await sleep(150);
  assert.ok(!ada.frames.some(f => f.type === "session.text-delta" && String(f.data.text).includes("SECRET")), "ada, who joined mid-reply, got none of it");
  assert.ok(!ada.frames.some(f => f.type === "session.text-done"), "nor its end");
  const mine = w.seamCalls.filter(c => c.startsWith(`${kit}:`));
  assert.equal(mine[0], `${kit}:beginTurn`, "the turn began before the reply opened");
  assert.ok(mine.includes(`${kit}:appendOpen`));
  const kernelLog = w.k.log.read({}).filter((/** @type {any} */ e) => e.type === "message.opened");
  assert.ok(kernelLog.some((/** @type {any} */ e) => e.data.by.agent === "kit"), "the kernel recorded the assistant's reply, opened under the assistant's own session");
  await b.stop();
});

/** boot() with a stopper registered for the test. @param {any} w @param {any} t */
async function world0(w, t) { const b = await w.boot(); t.after(() => b.stop().catch(() => {})); return b; }

test("a restart in the middle of a turn: the seam reopens the person's session, and the real Switchboard's next reply streams through it", async t => {
  const w = await world(t);
  const b1 = await w.boot();
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  w.rig.chat = chat.id; w.rig.asker = "bob";
  const bob1 = await b1.watch("bob", chat.id);
  const sent = await b1.as("bob")("stream.send", { session: chat.id, text: LONG, to: ["assistant:kit"], cwd: w.work });
  assert.ok(!sent.error, sent.error && sent.error.message);
  await until(() => b1.stream().groups.member(chat.id, "assistant:kit")?.thread, "the thread");
  const kit = kitThread(b1, chat.id);
  assert.equal(w.kept.has(kit), true, "the open turn is kept (the person, the chat, the assistant; never a token)");
  assert.ok(!JSON.stringify([...w.kept.values()]).includes("token"));
  await until(() => textOf(bob1.frames).includes("SECRET"), "the first delta");
  await b1.stop(); // the daemon stops mid-turn: the Switchboard and its fake claude, the seam's sessions are gone with it, the kept turn is not
  const b2 = await w.boot();
  t.after(() => b2.stop().catch(() => {}));
  const bob = await b2.watch("bob", chat.id);
  await until(() => b2.ks.list().length === 1, "the session to be reopened by reopenPending");
  const again = await b2.as("bob")("stream.send", { session: chat.id, text: "after the restart", to: ["assistant:kit"], cwd: w.work });
  assert.ok(!again.error, again.error && again.error.message);
  await until(() => /after the restart/.test(textOf(bob.frames)), "the reply after the restart", 20_000);
  assert.ok(!bob.frames.some(f => f.type === "session.status" && f.data.state === "failed"), "nothing says it could not resume");
  assert.equal(w.seamCalls.filter(c => c === `${kit}:beginTurn`).length >= 2, true, "each turn began at the kernel");
});

test("a restart where the person can no longer be reopened: the turn is given up, the room is told, and a late reply from the real Switchboard is dropped", async t => {
  const w = await world(t);
  const b1 = await w.boot();
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  w.rig.chat = chat.id; w.rig.asker = "bob";
  const sent = await b1.as("bob")("stream.send", { session: chat.id, text: LONG, to: ["assistant:kit"], cwd: w.work });
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
  // the thread answers anyway (a message sent to the Switchboard past the rig's session-opening wrapper, as a send the stream no longer tracks): its reply has no session to open under
  const late = await b2.realCall("threads.send", { thread: kit, text: "NEVERSHOWN", surface: "deck", uuid: "late-1" }, "module:stream");
  assert.ok(!late.error, late.error && late.error.message);
  await until(async () => (await b2.reg.call("threads.get", { thread: kit, limit: 500 }, "cli")).data.events.some((/** @type {any} */ e) => e.type === "thread.text" && e.payload && e.payload.done && /NEVERSHOWN/.test(String(e.payload.text))), "the late reply from the Switchboard", 20_000);
  await sleep(200);
  assert.ok(!JSON.stringify(bob.frames).includes("NEVERSHOWN"));
});
