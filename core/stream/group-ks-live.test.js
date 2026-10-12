// @ts-check
// Step 7 of the E2E run, as far as it can run without a switchboard that carries the chat (chat 0.3 tasks S and T). What is REAL here: the kernel (createKernel: surfaces, chats, the room
// with beginTurn/appendOpen/mayReceive), lib/kernel-session.js (createKernelSessions with chats: the kernel's chats and a durable turns store), the stream module and its group
// chats, the REAL Switchboard (core/switchboard, the module named threads: threads.start/send/get, its own database, its own thread events) running the fake claude
// (core/switchboard/testing/fake-claude.js) as a real child process, the module registry that hands the stream the seam the way the daemon does (deps.kernelThreads ->
// ctx.kernelThreads by the module's own needs.daemon declaration), and real websockets for the viewers. The assistant's words are the fake claude's own stream-json deltas, translated by the Switchboard into thread.text events.
// Task U: the Switchboard itself now opens each turn's kernel session (threads.start and threads.send carry `chat` and `asker` from module:stream; the stream passes them). The rig only
// supplies deps.kernelSession the way core/daemon/index.js composes it; no registry call is wrapped. It is still not a vyred process: the same flow on a real process is core/stream/e2e-step7.test.js.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
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
async function world(t, sessionsExtra = {}) {
  const k = await createKernel({ space: SPACE, owner: BOB, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: BOB, path: "direct", session: "s" });   // bob owns this Space: his turns may run on the machine's own login; carol and ada have a sign-in of their own
  const g = k.gateway.grants;
  for (const [p, role] of [[CAROL, "member"], [ADA, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
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
  const saved = { FAKE_CLAUDE_DELTA_MS: process.env.FAKE_CLAUDE_DELTA_MS, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, VYRE_SESSIONS_THREAD_SOCKET: process.env.VYRE_SESSIONS_THREAD_SOCKET, VYRE_SESSIONS_SPAWNER: process.env.VYRE_SESSIONS_SPAWNER };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSIONS_THREAD_SOCKET: "on", VYRE_SESSIONS_SPAWNER: "off", FAKE_CLAUDE_DELTA_MS: "20" }); // a long reply streams for a few seconds, as these tests need
  t.after(() => { for (const [k2, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k2]; else process.env[k2] = v; } });
  const personChainFor = async (/** @type {string} */ person) => k.chains.fromFacts({ kind: "device", device_key_id: "vyred", person, path: "direct" });
  /** @type {any[]} */ const gaveUp = [];
  /** The asker of the session each stamped tool call used, in order. @type {{ asker: string | null, sid: string }[]} */ const stamped = [];
  /** What the Switchboard asked the daemon to open: the thread, the chat and the asker. @type {any[]} */ const asked = [];
  /** What the stream asked of the seam, in order, per thread: beginTurn must come before the first appendOpen. @type {string[]} */ const seamCalls = [];
  /** Askers the kernel cannot open a session for just now (a test sets it): the probe still passes for them, the session does not open. @type {Set<string>} */ const failOpen = new Set();

  /** Start the stream the way the daemon does: the Registry is handed the seam as deps.kernelThreads, over a createKernelSessions that has the kernel's chats and the durable turns. */
  // The bus is the kernel's log, which outlives a restart: every boot in this test shares one.
  const bus = new Events();
  async function boot(/** @type {{ personChainFor?: (p: string) => Promise<any>, timeoutMs?: number }} */ o = {}) {
    // the kernel's chats as the seam holds them, with the turn-begin counted: a turn must begin exactly once, when its session opens
    const kc = /** @type {any} */ (k.kernelFor({ name: "kernel-sessions" })).chats;
    const ks = createKernelSessions({ kernel: k, turns, chats: Object.freeze({ ...kc, beginTurn: async (/** @type {string} */ tok) => { seamCalls.push("BEGIN"); return kc.beginTurn(tok); } }) });
    const db = open(p.db);
    const events = bus;
    const reg = new Registry({ db, events, config: { role: "box", stream: { resumeWaitSeconds: o.timeoutMs ? o.timeoutMs / 1000 : 60 }, sessions: { install: false, ...sessionsExtra }, transcripts: [] }, paths: p, handler: () => (/** @type {any} */ _q, /** @type {any} */ r) => { r.writeHead(404); r.end(); }, log: process.env.E2E_DEBUG ? (/** @type {string} */ m) => console.error("LOG", m) : () => {}, kernelFor });
    // a person's local surface arrives as the owner's own device, as through the real socket (the Switchboard's chat gate needs a person chain)
    { const orig = reg.call.bind(reg); reg.call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ m) => orig(tool, input, caller, m !== undefined ? m : (/^(cli|deck|local|capsule)$/.test(String(caller)) ? { kernelFacts: { kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "s" } } : undefined)); }
    reg.deps.kernelThreads = Object.freeze({
      forThread: (/** @type {string} */ thread) => {
        const s = ks.forThread(thread);
        return Object.freeze({ ...s, beginTurn: async () => { seamCalls.push(`${thread}:beginTurn`); return s.beginTurn(); }, appendOpen: async (/** @type {any} */ m) => { seamCalls.push(`${thread}:appendOpen`); return s.appendOpen(m); } });
      },
      reopenPending: (/** @type {any} */ a) => ks.reopenPending({ personChainFor: o.personChainFor || personChainFor, ...a }),
    });
    // vyred's side of a person's send, as the daemon composes it (core/daemon/index.js): the Switchboard asks deps.kernelSession for each turn and gets the asker's own session in the chat.
    // Nothing here wraps a call: the Switchboard itself carries chat and asker (it honours them from module:stream alone).
    reg.deps.sandbox = { off: true }; // the daemon's own development switch (VYRE_SESSION_SANDBOX_OFF=1): the sandbox has its own tests
    reg.deps.kernelSession = async (/** @type {{ thread: string, agent: string | null, rec?: any, chat?: string, asker?: string }} */ q) => {
      const person = k.chains.fromFacts({ kind: "session_person", person: q.asker || OWNER, session: `thread:${q.thread}`, vouched: true });
      const chat = q.chat || (q.rec && typeof q.rec.chat === "string" ? q.rec.chat : undefined);
      // The Switchboard asks "is this asker in this chat?" before it queues or runs a turn (probe): a membership read, no session, no turn begun, not a session asked for.
      // (core/daemon/index.js opens a real session for a probe and never ends it: reported to platform and sessions.)
      if (/** @type {any} */ (q).probe) { await g.chats.read(person, /** @type {string} */ (chat)); return { token: () => "", end: async () => {} }; }
      asked.push({ thread: q.thread, chat: chat || null, asker: q.asker || null });
      if (q.asker && failOpen.has(q.asker)) throw new Error("the kernel could not open a session for this turn");
      if (process.env.E2E_DEBUG) console.error("KSOPEN", JSON.stringify({ chat, asker: q.asker, agent: q.agent }));
      // as the daemon does (core/daemon/index.js kernelSession): a run with no agent in a chat is a model slot, and its token's agent hop is the slot id
      const agent = q.agent || (chat && q.rec && typeof q.rec.slot === "string" && q.rec.slot.startsWith("model:") ? q.rec.slot : undefined);
      const s = await ks.open({ chain: person, ...(chat ? { chat } : {}), ...(agent ? { agent } : {}), ...(agent && agent.startsWith("model:") ? { slotOpen: true } : {}), thread: q.thread });
      const tf = ks.tokenFor(s.id);
      // every time the thread socket asks for the token to stamp on a tool call, whose session it asked
      return { token: () => { stamped.push({ asker: q.asker || null, sid: s.id }); return tf(); }, end: () => ks.end(s.id) };
    };
    await reg.start(discover([CORE]).filter(f => f.manifest && (["stream", "threads", "sessions"].includes(f.manifest.name))), { role: "box" });
    for (const m of ["sessions", "threads", "stream"]) assert.equal(reg.modules.get(m)?.state, "running", reg.modules.get(m)?.error);
    // everyone runs on a sign-in of their own (the fake claude is the provider; bob's, the owner's, is the Space's own account): added once, kept across the restarts of this rig
    for (const who of ["bob", "carol", "ada"]) {
      const have = await reg.call("sessions.accounts.list", { provider: "claude" }, "deck", { token: tokens[who] });
      if ((have.data || []).some((/** @type {any} */ a) => !a.synthetic)) continue;
      const added = await reg.call("sessions.accounts.add", { provider: "claude", label: `${who}'s Claude`, kind: "login" }, "deck", { token: tokens[who] });
      assert.ok(!added.error, added.error && added.error.message);
      db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), added.data.id);
    }
    const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
    s.on("upgrade", (req, socket, head) => { reg.upgrades.get("stream/session").handler(req, socket, head, { caller: "deck", url: new URL(req.url || "/", "http://vyred") }); });
    await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
    const port = /** @type {any} */ (s.address()).port;
    const as = (/** @type {string} */ who) => (/** @type {string} */ tool, /** @type {any} */ input) => reg.call(tool, input, "deck", { token: tokens[who] });
    const stop = async () => { s.closeAllConnections(); s.close(); await reg.stop(); db.close(); };
    const watch = async (/** @type {string} */ who, /** @type {string} */ session) => {
      /** @type {any[]} */ const frames = [];
      const c = connect({ open: async ({ from }) => { const r = await as(who)("stream.open", { chat: session, from }); assert.ok(!r.error, r.error && r.error.message); return wsDuplex(`ws://127.0.0.1:${port}${r.data.path}`); }, onFrame: f => frames.push(f), backoff: { base: 5, cap: 10 } });
      t.after(() => c.close());
      return { frames, close: () => c.close() };
    };
    return { ks, reg, realCall: reg.call.bind(reg), as, port, stop, watch, stream: () => reg.modules.get("stream")?.handle, events };
  }
  /** A daemon that dies mid-turn: what kill -9 leaves is the durable turn store as it was (a graceful stop ends each session, which forgets its turn, so put them back). */
  const crash = async (/** @type {{ stop: () => Promise<void> }} */ b) => { const snap = new Map(kept); await b.stop(); for (const [x, r] of snap) kept.set(x, r); };
  return { k, chains, tokens, kept, crash, boot, gaveUp, asked, stamped, failOpen, work, seamCalls, paths: p, C: g.chats };
}
const textOf = (/** @type {any[]} */ frames) => frames.filter(f => f.type === "chat.text-delta" && !f.data.reasoning).map(f => f.data.text).join("");
const kitThread = (/** @type {any} */ b, /** @type {string} */ chat) => String(b.stream().groups.member(chat, "assistant:assistant").thread);

const LONG = "SECRET " + Array(500).fill("word").join(" "); // the fake claude says it back in six-character deltas, a few milliseconds apart: a reply that is still arriving for a couple of seconds

test("a person sends, the real Switchboard's reply streams through the seam's handle, beginTurn comes first, and a person who joined mid-reply does not receive it", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const bob = await b.watch("bob", chat.id);
  const sent = await b.as("bob")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!sent.error, sent.error && `${sent.error.code} ${sent.error.message}`);
  await until(() => b.stream().groups.member(chat.id, "assistant:assistant")?.thread, "the thread");
  const kit = kitThread(b, chat.id);
  assert.deepEqual(b.ks.list().length, 1, "vyred holds one kernel session, for the assistant's thread");
  assert.ok((await b.reg.call("threads.get", { thread: kit, limit: 5 }, "cli")).data.thread, "the thread is the real Switchboard's own record");
  await until(() => textOf(bob.frames).includes("SECRET"), "the first delta");
  assert.ok(!bob.frames.some(f => f.type === "chat.text-done"), "the reply is still arriving");
  await w.C.change(w.chains.bob, chat.id, { add_people: [ADA] });
  const ada = await b.watch("ada", chat.id);
  await until(() => bob.frames.some(f => f.type === "chat.text-done"), "the reply to finish", 20_000);
  assert.equal(textOf(bob.frames), `echo: ${LONG}`, "bob got the fake claude's own words, as they streamed");
  await sleep(150);
  assert.ok(!ada.frames.some(f => f.type === "chat.text-delta" && String(f.data.text).includes("SECRET")), "ada, who joined mid-reply, got none of it");
  assert.ok(!ada.frames.some(f => f.type === "chat.text-done"), "nor its end");
  assert.equal(w.seamCalls.filter(c => c === "BEGIN").length, 1, "the turn began at the kernel exactly once, when its session opened");
  assert.ok(w.seamCalls.indexOf("BEGIN") < w.seamCalls.indexOf(`${kit}:appendOpen`), "and before the reply opened");
  assert.ok(!w.seamCalls.includes(`${kit}:beginTurn`), "the stream does not begin it again itself");
  const kernelLog = w.k.log.read({}).filter((/** @type {any} */ e) => e.type === "message.opened");
  assert.ok(kernelLog.some((/** @type {any} */ e) => String(e.data.by.agent || "").startsWith("model:")), "the kernel recorded the reply, opened under the model slot's own session");
  await b.stop();
});

test("a turn asked by carol is stamped with carol's session, and chat and asker named on stream.send by a caller are ignored", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const other = await w.C.create(w.chains.bob, { people: [], assistants: ["assistant"] });
  const carol = await b.watch("carol", chat.id);
  // carol also names another chat and another asker in her own call: the stream takes them from the group and the caller's chain, never from the input
  // (the input schema now refuses a key the tool does not take, so the spoof is refused outright and nothing is sent or asked)
  const spoof = await b.as("carol")("stream.send", { chat: chat.id, text: "hello from carol", to: ["assistant:assistant"], cwd: w.work, chat: other.id, asker: BOB });
  assert.equal(spoof.error && spoof.error.code, "bad_input", "chat and asker are not inputs of stream.send");
  assert.equal(w.asked.length, 0, "nothing was asked of the Switchboard for the spoof");
  const sent = await b.as("carol")("stream.send", { chat: chat.id, text: "hello from carol", to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!sent.error, sent.error && `${sent.error.code} ${sent.error.message}`);
  await until(() => carol.frames.some(f => f.type === "chat.text-done"), "the reply", 20_000);
  assert.match(textOf(carol.frames), /hello from carol/);
  const kit = kitThread(b, chat.id);
  assert.deepEqual(w.asked.filter(a => a.thread === kit).map(a => ({ chat: a.chat, asker: a.asker })), [{ chat: chat.id, asker: CAROL }], "the Switchboard was asked to open carol's session in this chat");
  const opened = w.k.log.read({}).filter((/** @type {any} */ e) => e.type === "message.opened" && String(e.data.by.agent || "").startsWith("model:"));
  assert.ok(opened.length >= 1 && opened.every((/** @type {any} */ e) => e.data.by.person === CAROL && e.data.chat === chat.id), "every reply the kernel recorded was opened under carol's session, not the owner's or bob's");
  await b.stop();
});

test("a person who is not in the chat gets no session and no reply, from the stream or from a direct call", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const bob = await b.watch("bob", chat.id);
  // ada is not in the chat: the stream refuses her send
  const out = await b.as("ada")("stream.send", { chat: chat.id, text: "ADASECRET", to: ["assistant:assistant"], cwd: w.work });
  assert.ok(out.error, "an outsider's send is refused");
  assert.equal(w.asked.length, 0, "no session was asked for");
  // and a turn the stream itself starts for an asker who is not in the chat: the kernel refuses the session, nothing is opened, no reply reaches the chat
  const r = await b.reg.call("threads.start", { cwd: w.work, prompt: "ADASECRET2", surface: "deck", chat: chat.id, asker: ADA }, "module:stream");
  await sleep(1500);
  assert.deepEqual(w.asked, [], "the Switchboard's membership probe refused ada before any session was asked for");
  assert.equal(b.ks.list().length, 0, "the kernel opened no session for ada");
  assert.ok(!w.k.log.read({}).some((/** @type {any} */ e) => e.type === "message.opened"), "no reply was recorded in the chat");
  assert.ok(!JSON.stringify(bob.frames).includes("ADASECRET"), "nothing she asked reached the room");
  assert.ok(r, "the call answered");
  await b.stop();
});

/** boot() with a stopper registered for the test. @param {any} w @param {any} t */
async function world0(w, t) { const b = await w.boot(); t.after(() => b.stop().catch(() => {})); return b; }

test("a restart in the middle of a turn: the seam reopens the person's session, and the real Switchboard's next reply streams through it", async t => {
  const w = await world(t);
  const b1 = await w.boot();
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const bob1 = await b1.watch("bob", chat.id);
  const sent = await b1.as("bob")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!sent.error, sent.error && sent.error.message);
  await until(() => b1.stream().groups.member(chat.id, "assistant:assistant")?.thread, "the thread");
  const kit = kitThread(b1, chat.id);
  assert.equal(w.kept.has(kit), true, "the open turn is kept (the person, the chat, the assistant; never a token)");
  assert.ok(!JSON.stringify([...w.kept.values()]).includes("token"));
  await until(() => textOf(bob1.frames).includes("SECRET"), "the first delta");
  await w.crash(b1); // the daemon dies mid-turn: the Switchboard and its fake claude, the seam's sessions are gone with it, the kept turn is not
  const b2 = await w.boot();
  t.after(() => b2.stop().catch(() => {}));
  const bob = await b2.watch("bob", chat.id);
  await until(() => b2.ks.list().length === 1, "the session to be reopened by reopenPending");
  const again = await b2.as("bob")("stream.send", { chat: chat.id, text: "after the restart", to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!again.error, again.error && again.error.message);
  await until(() => /after the restart/.test(textOf(bob.frames)), "the reply after the restart", 20_000);
  assert.ok(!bob.frames.some(f => f.type === "chat.status" && f.data.state === "failed"), "nothing says it could not resume");
  assert.equal(w.seamCalls.filter(c => c === "BEGIN").length >= 2, true, "each turn began at the kernel");
});

test("a restart where the person can no longer be reopened: the turn is given up, the room is told, and a late reply from the real Switchboard is dropped", async t => {
  const w = await world(t);
  const b1 = await w.boot();
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const sent = await b1.as("bob")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!sent.error, sent.error && sent.error.message);
  await until(() => b1.stream().groups.member(chat.id, "assistant:assistant")?.thread, "the thread");
  const kit = kitThread(b1, chat.id);
  await w.crash(b1);
  const b2 = await w.boot({ personChainFor: async () => { throw Object.assign(new Error("no longer a member"), { code: "not_found" }); } });
  t.after(() => b2.stop().catch(() => {}));
  const bob = await b2.watch("bob", chat.id);
  await until(() => bob.frames.some(f => f.type === "chat.status" && f.data.state === "failed"), "the give-up to show");
  assert.match(String(bob.frames.find(f => f.type === "chat.status" && f.data.state === "failed").data.note), /couldn't resume, ask again/);
  assert.equal(w.kept.has(kit), false, "the given-up turn is forgotten");
  // the thread answers anyway (a message sent to the Switchboard past the rig's session-opening wrapper, as a send the stream no longer tracks): its reply has no session to open under
  const late = await b2.realCall("threads.send", { thread: kit, text: "NEVERSHOWN", surface: "deck", uuid: "late-1" }, "module:stream", { origin: "deck" }); // a module acts for a person: the hop carries the class the call came from
  assert.ok(!late.error, late.error && late.error.message);
  await until(async () => (await b2.reg.call("threads.get", { thread: kit, limit: 500 }, "cli")).data.events.some((/** @type {any} */ e) => e.type === "thread.text" && e.payload && e.payload.done && /NEVERSHOWN/.test(String(e.payload.text))), "the late reply from the Switchboard", 20_000);
  await sleep(200);
  assert.ok(!JSON.stringify(bob.frames).includes("NEVERSHOWN"));
});

// ---- task V: a second person speaks while a turn runs (the stream owns the queue; reviewer SS-1 and SS-2) ----------------------------------------------------------------------------

/** The person a live kernel session of the seam is for. @param {any} w @param {any} b @param {string} id */
const personOfSession = async (w, b, id) => (await w.k.surfaces.verify(await b.ks.tokenFor(id)())).person;
const userMsgs = (/** @type {any[]} */ frames) => frames.filter(f => f.type === "chat.user-message" && f.data.state === "sent").map(f => String(f.data.text));
const opened = (/** @type {any} */ w) => w.k.log.read({}).filter((/** @type {any} */ e) => e.type === "message.opened" && String(e.data.by.agent || "").startsWith("model:")).map((/** @type {any} */ e) => e.data.by.person);
// Everyone runs on a sign-in of their own, so a turn by someone other than the thread's first asker is a one-turn on THEIR account: announced by a notice ("This turn runs on...", "Back on..."), handed the
// conversation (its echo carries the seed before the words), and it opens a session for its launch and for its send. These tests therefore read each reply BY WHAT WAS SAID, never by position or count:
// `replyOf` finds the echo of one message's words and the kernel message it was written as (`rid`), `askerOf` reads the person that message was opened under, and `at` is where its last frame sits (arrival order).
const said = (/** @type {string} */ echo) => (echo.includes("[Vyre continuation") ? echo.slice(echo.lastIndexOf("]") + 1).replace(/^(\\n|\s)+/, "") : echo.replace(/^echo: /, ""));
/** @returns {{ text: string, rid: string, at: number } | null} the one reply that echoes `words` (null: none yet) */
function replyOf(/** @type {any[]} */ frames, /** @type {string} */ words) {
  /** @type {Map<string, { text: string, rid: string, at: number, done: boolean }>} */ const by = new Map();
  frames.forEach((f, i) => {
    if ((f.type !== "chat.text-delta" && f.type !== "chat.text-done") || f.data.reasoning) return;
    const id = String(f.data.message), r = by.get(id) || { text: "", rid: "", at: -1, done: false };
    if (f.type === "chat.text-delta") r.text += f.data.text; else { r.done = true; r.at = i; }
    if (f.data.rid) r.rid = String(f.data.rid);
    by.set(id, r);
  });
  const hits = [...by.values()].filter(r => r.done && r.text.startsWith("echo:") && said(r.text) === words);
  assert.ok(hits.length <= 1, `the words ${JSON.stringify(words.slice(0, 20))} were answered ${hits.length} times`);
  return hits[0] || null;
}
const askerOf = (/** @type {any} */ w, /** @type {string} */ rid) => { const e = w.k.log.read({}).find((/** @type {any} */ x) => x.type === "message.opened" && x.data.id === rid); return e ? e.data.by.person : null; };
const inOrder = (/** @type {string[]} */ list) => list.filter((a, i) => i === 0 || a !== list[i - 1]);
const askersOf = (/** @type {any} */ w) => inOrder(w.asked.map((/** @type {any} */ a) => a.asker));
/** Wait for the reply to these words, and say who it was written for: { who, at }. */
async function answered(/** @type {any} */ w, /** @type {any} */ watcher, /** @type {string} */ words, ms = 60_000) {
  await until(() => replyOf(watcher.frames, words), `the reply to ${JSON.stringify(words.slice(0, 20))}`, ms);
  const r = /** @type {any} */ (replyOf(watcher.frames, words));
  await until(() => askerOf(w, r.rid), "the kernel's record of that reply", 5000);
  return { who: askerOf(w, r.rid), at: r.at };
}

test("V1: an admin speaks mid-turn: the member's turn keeps the member's session and stays refused, the admin's words are written at once and get their own turn under the admin after it", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  // carol asks (she also writes `as` naming bob (`asker` is not an input any more): the author is the chain the call was made under, never the input)
  const first = await b.as("carol")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work, as: `person:${BOB}` });
  assert.ok(!first.error, first.error && first.error.message);
  await until(() => textOf(watcher.frames).includes("SECRET"), "carol's turn to be running");
  const [sid] = b.ks.list();
  assert.equal(await personOfSession(w, b, sid), CAROL, "the running turn is under carol's session");
  const grant = async () => { const tok = await b.ks.tokenFor(sid)(); const ch = await w.k.surfaces.chainFor(tok); return w.k.gateway.grants.setRole(ch, { person: ADA, role: "manager" }).then(() => "allowed", (/** @type {any} */ e) => e.code); };
  const before = await grant();
  assert.notEqual(before, "allowed", "an action carol's turn may not do is refused");
  // the admin speaks while carol's turn runs
  const second = await b.as("bob")("stream.send", { chat: chat.id, text: "ok, continue", to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!second.error, second.error && second.error.message);
  await until(() => userMsgs(watcher.frames).includes("ok, continue"), "the admin's own words in the chat");
  assert.equal(w.asked.length, 1, "...while the admin has no turn yet");
  const user = watcher.frames.find(f => f.type === "chat.user-message" && f.data.text === LONG);
  assert.equal(user.author, `person:${CAROL}`, "carol's message is carol's, not bob's");
  await sleep(200);
  assert.equal(await personOfSession(w, b, sid), CAROL, "the running turn still holds carol's session after the admin spoke");
  assert.equal(b.ks.list().length, 1, "no second session was opened mid-turn");
  assert.equal(await grant(), before, "and what was refused stays refused");
  assert.deepEqual(w.asked.map(a => a.asker), [CAROL], "the Switchboard has been asked for carol's session only");
  const bobs = await answered(w, watcher, "ok, continue", 60_000);
  const carols = await answered(w, watcher, LONG);
  assert.equal(carols.who, CAROL, "carol's turn was written for carol");
  assert.equal(bobs.who, BOB, "bob's turn was written for bob");
  assert.ok(carols.at < bobs.at, "bob's turn came after carol's");
  assert.deepEqual(askersOf(w), [CAROL, BOB], "bob's turn opened under bob, after carol's");
  assert.equal(userMsgs(watcher.frames).filter(x => x === "ok, continue").length, 1, "the admin's words are in the chat once");
  assert.ok(!said(/** @type {any} */ (replyOf(watcher.frames, "ok, continue")).text).includes("SECRET"), "never merged into carol's turn");
});

/** Queue a message of bob's behind carol's running turn and give the row no account hop (as an earlier build wrote it, or an asker whose account is the thread's own): the drain then delivers it directly. */
async function queueBobsRow(/** @type {any} */ w, /** @type {any} */ b, /** @type {any} */ chat, /** @type {any} */ watcher, /** @type {string} */ words) {
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "the running turn");
  const kit = kitThread(b, chat.id);
  const sent = await b.as("bob")("stream.send", { chat: chat.id, text: words, to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!sent.error, sent.error && sent.error.message);
  const dbq = (/** @type {(db: any) => any} */ f) => { const db = open(w.paths.db); try { return f(db); } finally { db.close(); } };
  await until(() => dbq(db => db.prepare("SELECT 1 FROM threads_inbox WHERE thread = ? AND text = ?").get(kit, words)), "the row to wait in the Switchboard's queue");
  dbq(db => { const r = /** @type {any} */ (db.prepare("SELECT id, kturn FROM threads_inbox WHERE thread = ? AND text = ?").get(kit, words)); const { over, ...rest } = JSON.parse(String(r.kturn)); assert.ok(over, "the row had a hop"); db.prepare("UPDATE threads_inbox SET kturn = ? WHERE id = ?").run(JSON.stringify(rest), r.id); });
  const events = async () => { const r = await b.as("carol")("threads.get", { thread: kit, limit: 400 }); if (!r.data) throw new Error(JSON.stringify(r).slice(0, 300)); return r.data.events; };
  const row = () => dbq(db => db.prepare("SELECT via FROM threads_inbox WHERE thread = ? AND text = ?").get(kit, words));
  return { events, row };
}
const heard = (/** @type {any[]} */ events, /** @type {string} */ words) => events.filter(e => e.type === "thread.text").map(e => String(e.payload && e.payload.text)).some(x => x.includes(words));

test("D1: a message queued behind a running turn whose asker left the chat while it waited is dropped: the row is marked dropped, nothing is written to the thread, and the person is told", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("carol", chat.id);
  const { events, row } = await queueBobsRow(w, b, chat, watcher, "B-LEFT");
  await w.C.change(w.chains.bob, chat.id, { remove_people: [BOB] });   // bob leaves the chat while his row waits
  await until(async () => (await events()).some((/** @type {any} */ e) => e.type === "thread.text" && /no longer in this chat/.test(String(e.payload && e.payload.text))), "the person to be told", 40_000);
  await sleep(1500);
  assert.equal(row().via, "dropped", "the row is marked dropped, not delivered");
  assert.ok(!heard(await events(), "B-LEFT"), "the thread never heard his words");
  for (const sid of b.ks.list()) assert.notEqual(await personOfSession(w, b, sid), BOB, "no kernel session is open for him");
});

test("D2: a queued message whose asker is still in the chat but whose kernel session cannot be opened when its turn comes is dropped too: never written to the thread without a token", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("carol", chat.id);
  const { events, row } = await queueBobsRow(w, b, chat, watcher, "B-NOTOKEN");
  // the asker is asked after again (a probe: still in the chat) and passes; opening the session for the turn then fails (he left in the gap, or the kernel could not)
  w.failOpen.add(BOB);
  await until(async () => (await events()).some((/** @type {any} */ e) => e.type === "thread.text" && /could not be opened for you/.test(String(e.payload && e.payload.text))), "the person to be told", 40_000);
  await sleep(1500);
  assert.equal(row().via, "dropped", "the row is marked dropped");
  assert.ok(!heard(await events(), "B-NOTOKEN"), "the thread never heard his words");
});

test("D3: when one queued message is dropped because its session cannot be opened, the messages behind it still run, and the stream is not left on the dropped turn", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  const { events, row } = await queueBobsRow(w, b, chat, watcher, "B-DROPPED");
  assert.ok(!(await b.as("ada")("stream.send", { chat: chat.id, text: "A-AFTER", to: ["assistant:assistant"], cwd: w.work })).error);
  w.failOpen.add(BOB);
  await until(async () => (await events()).some((/** @type {any} */ e) => e.type === "thread.text" && /could not be opened for you/.test(String(e.payload && e.payload.text))), "bob's message to be dropped", 60_000);
  const ada = await answered(w, watcher, "A-AFTER", 90_000);
  assert.equal(ada.who, ADA, "the message behind the dropped one ran, under its own asker");
  assert.equal(row().via, "dropped");
  await until(() => !b.stream().groups.member(chat.id, "assistant:assistant").running, "the stream not to be left running", 20_000);
});

test("V2: two people's waiting messages are two turns, in arrival order, each under its own asker", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "the running turn");
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "B-ONE", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.ok(!(await b.as("ada")("stream.send", { chat: chat.id, text: "A-ONE", to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => userMsgs(watcher.frames).length >= 3, "both words in the chat");
  assert.deepEqual(userMsgs(watcher.frames).slice(1), ["B-ONE", "A-ONE"], "both are in the chat at once, in arrival order");
  assert.equal(w.asked.length, 1, "neither has a turn yet");
  const bob1 = await answered(w, watcher, "B-ONE", 90_000), ada1 = await answered(w, watcher, "A-ONE", 90_000), carol1 = await answered(w, watcher, LONG);
  assert.deepEqual([carol1.who, bob1.who, ada1.who], [CAROL, BOB, ADA], "each message was answered under its own asker");
  assert.ok(carol1.at < bob1.at && bob1.at < ada1.at, "in arrival order: one turn per message, never merged into one");
  assert.deepEqual(askersOf(w), [CAROL, BOB, ADA], "three turns, one per message, in arrival order");
});

// TODO (found by putting this test on everyone's own account, 11 Oct; every run): with three different queued askers (bob, ada, bob) the SECOND one's turn runs in the thread (the echo of A-ONE is there) but the
// chat never gets a reply for it: the stream writes ada's text under bob's message (the kernel opened ada's reply under no model slot, bob's under three) and the chat ends with status "failed, couldn't resume".
// Until 6b23d3b6a the same test failed earlier, with "This session is open somewhere else: claude process N has it open" (the previous hop's process not in `ours()`). Two queued askers pass (V2). The assertions
// below are the claim this test always made, now per message.
test("V2s: a session wrapped in a subreaper (tini on a box that has it): the queued turn of another asker is still answered, not refused as open somewhere else", async t => {
  // the wrapped claude is a CHILD of the pid the Switchboard records; it must still count as ours
  const w = await world(t, { subreaper: path.join(CORE, "switchboard", "testing", "fake-subreaper.js") });
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "the running turn");
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "B-ONE", to: ["assistant:assistant"], cwd: w.work })).error);
  const bob1 = await answered(w, watcher, "B-ONE", 90_000), carol1 = await answered(w, watcher, LONG);
  assert.deepEqual([carol1.who, bob1.who], [CAROL, BOB], "each message was answered under its own asker");
  assert.ok(!textOf(watcher.frames).includes("open somewhere else"), "and nobody was told the session is open somewhere else");
});

test("V2b: three people queue behind a running turn, one of them twice: four turns in arrival order, each under its own asker, no reply cut", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "the running turn");
  for (const [who, text] of [["bob", "B-ONE"], ["ada", "A-ONE"], ["bob", "B-TWO"]]) assert.ok(!(await b.as(who)("stream.send", { chat: chat.id, text, to: ["assistant:assistant"], cwd: w.work })).error);
  const b1 = await answered(w, watcher, "B-ONE", 120_000), a1 = await answered(w, watcher, "A-ONE", 120_000), b2 = await answered(w, watcher, "B-TWO", 120_000), c1 = await answered(w, watcher, LONG);
  assert.deepEqual([c1.who, b1.who, a1.who, b2.who], [CAROL, BOB, ADA, BOB], "each message was answered under its own asker");
  assert.ok(c1.at < b1.at && b1.at < a1.at && a1.at < b2.at, "in arrival order, none cut, none merged");
  assert.deepEqual(askersOf(w), [CAROL, BOB, ADA, BOB], "four turns, in arrival order, each opened under its own asker");
});

test("Q3: the owner's turn is running and two members queue behind it: three turns, three answers, in arrival order, each under its own asker; none dropped, none doubled", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "the running turn");
  for (const [who, text] of [["carol", "C-Q1"], ["ada", "A-Q2"]]) assert.ok(!(await b.as(who)("stream.send", { chat: chat.id, text, to: ["assistant:assistant"], cwd: w.work })).error);
  const c = await answered(w, watcher, "C-Q1", 120_000), a = await answered(w, watcher, "A-Q2", 120_000);
  const first = await answered(w, watcher, LONG);
  assert.deepEqual([first.who, c.who, a.who], [BOB, CAROL, ADA]);
  assert.ok(first.at < c.at && c.at < a.at, "in arrival order");
  assert.deepEqual(askersOf(w), [BOB, CAROL, ADA], "exactly three turns, each opened under its own asker");
  assert.ok(!watcher.frames.some(f => f.type === "chat.status" && f.data.state === "failed"), "no reply was dropped");
});

test("CU1: the catchup rule is what others said since you last read: a sender's catchup holds the answer and the other person's message, not her own, and unread counts others only", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("carol", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: "C-HELLO", to: ["assistant:assistant"], cwd: w.work })).error);
  await answered(w, watcher, "C-HELLO", 60_000);
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "B-HELLO", to: ["assistant:assistant"], cwd: w.work })).error);
  await answered(w, watcher, "B-HELLO", 60_000);
  const c = await b.as("carol")("stream.catchup", { chat: chat.id });
  assert.ok(!c.error, c.error && c.error.message);
  const ms = c.data.messages;
  assert.ok(!ms.some((/** @type {any} */ m) => /^person:/.test(m.author) && /C-HELLO/.test(m.text) && m.author.includes(CAROL)), "her own message is not in her catchup (she knows what she wrote)");
  assert.ok(ms.some((/** @type {any} */ m) => /echo: C-HELLO/.test(m.text)), "its answer is");
  assert.ok(ms.some((/** @type {any} */ m) => /B-HELLO/.test(m.text)), "and the other person's message");
  assert.equal(c.data.unread, ms.length, "unread counts what others said, each entry once");
});

test("S1: a notice that arrives when a process starts with no turn in flight (the Switchboard's 'Back on ...' line after a hop back, a replayed session) is shown to the room and never opens a reply under the previous asker: no 'couldn't resume', and the next message is answered", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: "C-FIRST", to: ["assistant:assistant"], cwd: w.work })).error);
  await answered(w, watcher, "C-FIRST", 60_000);
  const thread = kitThread(b, chat.id);
  await until(async () => (await b.reg.call("threads.get", { thread }, "cli")).data.thread.status !== "working", "carol's turn to end", 30_000);
  for (const id of b.ks.list()) await b.ks.end(id);   // the previous asker's session is gone, as it is some seconds after her turn
  // a process starts for no turn (status working), and says a line as Vyre
  b.events.emit("threads", "thread.status", { status: "working", chat: chat.id }, { thread });
  b.events.emit("threads", "thread.text", { message: "vyre", text: "Back on the usual account. Nothing was lost.", done: true, notice: true }, { thread });
  await until(() => textOf(watcher.frames).includes("Back on the usual account"), "the line to reach the room", 20_000);
  await sleep(500);
  b.events.emit("threads", "thread.status", { status: "waiting", chat: chat.id }, { thread });
  assert.ok(!watcher.frames.some(f => f.type === "chat.status" && f.data.state === "failed"), "nothing says the reply could not resume");
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: "C-SECOND", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.equal((await answered(w, watcher, "C-SECOND", 60_000)).who, CAROL, "and the next message is answered under its own asker");
});

test("E1: three people queued behind the owner's turn, and that turn is stopped (it ends abnormally): the queued messages are not dropped, each is answered under its own asker", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: LONGER, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "the running turn");
  for (const [who, text] of [["carol", "C-E1"], ["ada", "A-E1"]]) assert.ok(!(await b.as(who)("stream.send", { chat: chat.id, text, to: ["assistant:assistant"], cwd: w.work })).error);
  const kit = kitThread(b, chat.id);
  await sleep(1500);
  const stopped = await b.reg.call("threads.stop", { thread: kit }, "deck", { token: w.tokens.bob });   // the running turn ends abnormally
  assert.ok(!stopped.error, stopped.error && stopped.error.message);
  const c = await answered(w, watcher, "C-E1", 120_000), a = await answered(w, watcher, "A-E1", 120_000);
  assert.deepEqual([c.who, a.who], [CAROL, ADA]);
  assert.deepEqual(askersOf(w).filter(Boolean), [BOB, CAROL, ADA], "the turn that was stopped is not run again for the person who stopped it: three persons' turns, not four (the restart itself opens no one's session)");
  assert.ok(!watcher.frames.some(f => f.type === "chat.status" && f.data.state === "failed" && /resume/.test(String(f.data.note))), "nothing says it could not resume");
});

test("V2t: the queued variant with a tool call in every turn: each tool call is stamped with the session of the person whose turn it is, per message", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "the running turn");
  for (const [who, text] of [["bob", "vyre threads.list {\"limit\":1}"], ["ada", "vyre threads.list {\"limit\":2}"], ["bob", "vyre threads.list {\"limit\":3}"]]) assert.ok(!(await b.as(who)("stream.send", { chat: chat.id, text, to: ["assistant:assistant"], cwd: w.work })).error);
  const order = () => w.stamped.map(x => x.asker).filter((x, i, a) => x !== a[i - 1]);
  await until(() => order().length >= 3, "a tool call in each of the three queued turns", 150_000);
  await sleep(1500);
  assert.deepEqual(order(), [BOB, ADA, BOB], "the tool calls were stamped with bob's, then ada's, then bob's own session, never another person's");
});

test("FAILBACK: the switch back after carol's hop fails twice: the chat goes dormant on bob's account, says so once, and the rows queued behind (bob's, then ada's) run after the resume, none of them written into carol's process", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  const db = /** @type {any} */ (b.reg.deps.db || /** @type {any} */ (b.reg).db);
  const acct = (/** @type {string} */ who) => db.prepare("SELECT id FROM sessions_accounts WHERE label = ?").get(`${who}'s Claude`).id;
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "B-FIRST", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.equal((await answered(w, watcher, "B-FIRST", 60_000)).who, BOB);
  // the switch back is made to fail twice: the first two lookups of bob's account after this point (the two tries to go back to it) answer "unavailable"
  let failures = 2; const real = b.reg.call.bind(b.reg), bobsAccount = acct("bob");
  b.reg.call = async (/** @type {any} */ ...a) => {
    if (a[0] === "sessions.accounts.resolve" && a[1] && a[1].account === bobsAccount && failures > 0) { failures--; return { error: { code: "unavailable", message: "the account could not be looked up just now" } }; }
    return real(...a);
  };
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "carol's turn running on her own account");
  for (const [who, text] of [["bob", "B-QUEUED"], ["ada", "A-AFTER"]]) assert.ok(!(await b.as(who)("stream.send", { chat: chat.id, text, to: ["assistant:assistant"], cwd: w.work })).error);
  const notice = () => watcher.frames.findIndex(f => f.type === "chat.text-done" && /session stopped while switching back/.test(JSON.stringify(f.data)) || (f.type === "chat.text-delta" && /session stopped while switching back/.test(String(f.data.text))));
  await until(() => notice() >= 0, "the room is told the session stopped while switching back", 120_000);
  assert.equal(failures, 0, "both tries to switch back failed");
  const th = kitThread(b, chat.id);
  const bobQueued = await answered(w, watcher, "B-QUEUED", 120_000), adaAfter = await answered(w, watcher, "A-AFTER", 120_000);
  assert.equal(bobQueued.who, BOB, "bob's queued row ran after the resume, under bob's session");
  assert.equal(adaAfter.who, ADA, "and ada's behind it, under ada's");
  assert.ok(bobQueued.at > notice() && adaAfter.at > bobQueued.at, "both came after the notice and in order: none of them was written into carol's process before the thread went dormant");
  const rec = db.prepare("SELECT account, opts FROM threads_runs WHERE id = ?").get(th);
  assert.equal(watcher.frames.filter(f => /session stopped while switching back/.test(JSON.stringify(f.data || {})) && f.type === "chat.text-done").length <= 1, true, "told once");
});

test("R1: a message the Switchboard refuses (the sender has no sign-in of their own) is not left silent: the room gets a notice with the next step, the message is shown as not sent, and the outbox gives it up; the next person's message is still answered", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  const db = /** @type {any} */ (b.reg.deps.db || /** @type {any} */ (b.reg).db);
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "B-FIRST", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.equal((await answered(w, watcher, "B-FIRST", 60_000)).who, BOB);
  db.prepare("DELETE FROM sessions_accounts WHERE label = ?").run("carol's Claude");   // her sign-in is gone: the Switchboard will refuse her turn
  const carol = await b.as("carol")("stream.send", { chat: chat.id, text: "C-NOACCT", to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!carol.error, carol.error && carol.error.message);
  await until(() => watcher.frames.some(f => f.type === "chat.text-delta" && f.data.notice === true && /was not sent/.test(String(f.data.text))), "the room to be told", 60_000);
  const told = watcher.frames.filter(f => f.type === "chat.text-delta" && f.data.notice === true && /was not sent/.test(String(f.data.text)));
  assert.equal(told.length, 1, "once");
  assert.match(String(told[0].data.text), /send it again|sign in|ask the owner/i, "with the next step: " + told[0].data.text);
  assert.ok(!replyOf(watcher.frames, "C-NOACCT"), "and no reply to words that were never run");
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "B-AFTER", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.equal((await answered(w, watcher, "B-AFTER", 60_000)).who, BOB, "the next message is still answered");
});

/** Make the Switchboard's answer to the next threads.send calls of one text an error, as a refusal with a given code and message would be. */
function refuseSends(/** @type {any} */ b, /** @type {string} */ words, /** @type {string} */ code, /** @type {string} */ message) {
  const real = b.reg.call.bind(b.reg);
  let on = true;
  b.reg.call = async (/** @type {any} */ ...a) => (on && a[0] === "threads.send" && a[1] && String(a[1].text) === words ? { error: { code, message } } : real(...a));
  return () => { on = false; };
}

test("R2: the notice for a refused message is one fixed sentence for the cause, never the Switchboard's own words (an account label, a path, a token-shaped string stay out); two refusals inside a minute make one notice", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "B-FIRST", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.equal((await answered(w, watcher, "B-FIRST", 60_000)).who, BOB);
  const LEAK = `account Eve's Claude (acct_77) at /home/acct/2001/.claude with ${["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-")} on api.example.com`;
  refuseSends(b, "C-ONE", "account_unavailable", LEAK);
  refuseSends(b, "C-TWO", "account_unavailable", LEAK);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: "C-ONE", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: "C-TWO", to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => watcher.frames.some(f => f.type === "chat.text-delta" && f.data.notice === true && /was not sent/.test(String(f.data.text))), "the room to be told", 60_000);
  await sleep(2500);
  const notices = watcher.frames.filter(f => f.type === "chat.text-delta" && f.data.notice === true && /not sent/.test(String(f.data.text)));
  assert.equal(notices.length, 1, "two refusals inside a minute: one notice");
  const text = String(notices[0].data.text);
  assert.ok(!/Eve|acct_77|\/home\/acct|sk-ant|example\.com/.test(text), "nothing of the Switchboard's message reaches the room: " + text);
  assert.match(text, /Open AI accounts to sign in again/, "the fixed sentence for that cause, with the next step");
  assert.ok(!JSON.stringify(watcher.frames).match(/sk-ant|acct_77|\/home\/acct/), "and nowhere in the room's frames");
});

test("R3: a refusal that may go through later (unavailable) is not given up: it stays in the outbox, and after a restart it is delivered and answered", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b1 = await w.boot();
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b1.watch("bob", chat.id);
  assert.ok(!(await b1.as("bob")("stream.send", { chat: chat.id, text: "B-FIRST", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.equal((await answered(w, watcher, "B-FIRST", 60_000)).who, BOB);
  refuseSends(b1, "B-LATER", "unavailable", "the server is busy starting");
  assert.ok(!(await b1.as("bob")("stream.send", { chat: chat.id, text: "B-LATER", to: ["assistant:assistant"], cwd: w.work })).error);
  await sleep(3000);
  assert.ok(!watcher.frames.some(f => f.type === "chat.text-delta" && f.data.notice === true && /not sent|not kept/.test(String(f.data.text))), "no 'not sent' claim for a refusal that may pass");
  await w.crash(b1);
  const b2 = await w.boot();
  t.after(() => b2.stop().catch(() => {}));
  const again = await b2.watch("bob", chat.id);
  assert.equal((await answered(w, again, "B-LATER", 90_000)).who, BOB, "delivered at the next start, and answered");
});

test("V3: the stream does not hold, retry or queue: the Switchboard queues another person's send and answers queued with a queued_id; the message shows waiting, then picked up", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: LONGER, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "the running turn");
  /** @type {any[]} */ const sends = [];
  const real = b.reg.call.bind(b.reg);
  b.reg.call = async (/** @type {any} */ ...a) => { const r = await real(...a); if (a[0] === "threads.send" && /QUEUEDONE/.test(String(a[1] && a[1].text))) sends.push({ input: a[1], r }); return r; };
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "QUEUEDONE", to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => sends.length >= 1, "the send");
  assert.equal(sends[0].input.asker, BOB, "the asker is the bare person id (per_...), converted at the boundary");
  assert.equal(sends[0].input.chat, chat.id);
  assert.ok(!sends[0].r.error, "the Switchboard answered, it did not refuse as busy");
  const qid = sends[0].r.data.queued_id;
  assert.equal(typeof qid, "number", "the answer carries the queued_id");
  const states = () => watcher.frames.filter(f => f.type === "chat.user-message" && f.data.text === "QUEUEDONE").map(f => [f.data.state, f.data.queued_id]);
  await until(() => states().some(x => x[0] === "queued"), "the waiting state");
  assert.deepEqual(states().find(x => x[0] === "queued"), ["queued", qid], "shown as waiting for the current reply, by the Switchboard's queued_id");
  // the fake claude now echoes even a long text in a few hundred ms, so the turn can end while this runs: the claim is checked at the moment the message shows waiting, before the turn it waits for ends
  const askedWhileWaiting = w.asked.map(a => a.asker);
  await sleep(400);
  assert.equal(sends.length, 1, "the stream sent once: no hold, no retry, no polling");
  assert.deepEqual(askedWhileWaiting, [CAROL], "carol's turn is the only one that opened a session while the message waits");
  const queued = await answered(w, watcher, "QUEUEDONE", 90_000);
  assert.equal(queued.who, BOB, "the queued message was answered under its own asker");
  assert.equal(sends.length, 1, "still one send");
  assert.ok(states().some(x => x[0] === "picked-up" && x[1] === qid), "and it shows picked up when its turn started");
  assert.deepEqual(askersOf(w), [CAROL, BOB]);
  assert.equal(b.stream().groups.member(chat.id, "assistant:assistant").asker, `person:${BOB}`, "the replies from then on are bob's");
});

test("V3b: a bare name or an actor string as the asker is refused by the Switchboard as bad_input", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  for (const asker of ["bob", `person:${BOB}`, "", "Per_Bob"]) {
    const r = await b.reg.call("threads.start", { cwd: w.work, prompt: "x", surface: "deck", chat: chat.id, asker }, "module:stream", { origin: "deck" });
    assert.equal(r.error && r.error.code, "bad_input", `asker ${JSON.stringify(asker)}: ${JSON.stringify(r)}`);
  }
  assert.equal(w.asked.length, 0, "no session was opened for any of them");
});

const LONGER = "SECRET " + Array(3000).fill("word").join(" "); // a reply that is still arriving for several seconds: the daemon is crashed while it runs
test("V4: a restart with a message queued at the Switchboard: the queue is the Switchboard's and survives; the stream's outbox row is done", async t => {
  const w = await world(t);
  const b1 = await w.boot();
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watch1 = await b1.watch("bob", chat.id);
  assert.ok(!(await b1.as("carol")("stream.send", { chat: chat.id, text: LONGER, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watch1.frames).includes("SECRET"), "the running turn");
  assert.ok(!(await b1.as("bob")("stream.send", { chat: chat.id, text: "WAITING-B", to: ["assistant:assistant"], cwd: w.work })).error);
  const kit = kitThread(b1, chat.id);
  const outbox = () => { const db = open(w.paths.db); try { return db.prepare("SELECT text FROM stream_groups_outbox WHERE done = 0 ORDER BY rowid").all(); } finally { db.close(); } };
  const inbox = () => { const db = open(w.paths.db); try { return db.prepare("SELECT text, kturn FROM threads_inbox WHERE thread = ? ORDER BY id").all(kit); } finally { db.close(); } };
  await until(() => inbox().some((/** @type {any} */ r) => r.text === "WAITING-B"), "the Switchboard's queue to hold it");
  assert.deepEqual(outbox(), [], "the stream's outbox row completed on the queued answer");
  { const { over, ...kt } = JSON.parse(String(inbox().find((/** @type {any} */ r) => r.text === "WAITING-B").kturn)); assert.deepEqual(kt, { chat: chat.id, asker: BOB }, "the queued row carries its chat and asker"); assert.equal(over && over.person, BOB, "and the account it will run on is his own, chosen when it was asked"); }
  await w.crash(b1);
  assert.ok(inbox().some((/** @type {any} */ r) => r.text === "WAITING-B"), "the restart lost nothing: the Switchboard's queue is durable");
});

test("HOP: a thread bob started takes carol's one turn on her own account (her turn answers, on her account, under her session), and after the hop back it is on bob's account with bob as its person", { timeout: 200_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  const db = /** @type {any} */ (b.reg.deps.db || /** @type {any} */ (b.reg).db);
  const acct = (/** @type {string} */ who) => db.prepare("SELECT id FROM sessions_accounts WHERE label = ?").get(`${who}'s Claude`).id;
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "B-FIRST", to: ["assistant:assistant"], cwd: w.work })).error);
  const bobFirst = await answered(w, watcher, "B-FIRST", 60_000);
  assert.equal(bobFirst.who, BOB, "bob's turn was written under bob's session");
  const thread = kitThread(b, chat.id);
  const run = () => db.prepare("SELECT account, opts FROM threads_runs WHERE id = ?").get(thread);
  const bobsAccount = run().account, starter = JSON.parse(run().opts).person;
  assert.equal(starter, BOB, "bob started the thread");
  const seen = new Set();
  const poll = setInterval(() => { try { seen.add(run().account); } catch { /* the row is being rewritten */ } }, 20);
  t.after(() => clearInterval(poll));
  /** @type {string[]} */ const skillsFor = [];
  const realCall = b.reg.call.bind(b.reg);
  b.reg.call = async (/** @type {any} */ ...a) => { if (a[0] === "skills.materialise") skillsFor.push(String(a[1] && a[1].person)); return realCall(...a); };
  const sent = await b.as("carol")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!sent.error, sent.error && sent.error.message);
  const carolTurn = await answered(w, watcher, LONG, 90_000);   // the hop did not fail with account_removed
  assert.equal(carolTurn.who, CAROL, "carol's turn was written under carol's session");
  clearInterval(poll);
  assert.ok(seen.has(acct("carol")), `the turn ran on carol's own account: ${JSON.stringify([...seen])}`);
  assert.equal(skillsFor[0], CAROL, `carol's hop was given carol's skills: ${JSON.stringify(skillsFor)}`);
  assert.ok(w.asked.some(a => a.asker === CAROL), "and under carol's session");
  assert.ok(!textOf(watcher.frames).includes("account_removed"), "no account_removed anywhere in the chat");
  // the hop back: bob's account again, bob as its person, and no hop person but the starter
  await until(() => run().account === bobsAccount, "the thread to go back to bob's account", 30_000);
  assert.equal(skillsFor[skillsFor.length - 1], BOB, `and the hop back was given bob's skills, not nobody's: ${JSON.stringify(skillsFor)}`);
  assert.equal(JSON.parse(run().opts).person, BOB, "bob is still the thread's person");
});

/** bob starts the chat's thread; carol's long turn runs on her own account (a hop); returns what the stop and restart tests need. */
async function carolMidHop(/** @type {any} */ w, /** @type {any} */ b, /** @type {any} */ t, /** @type {string} */ long) {
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  const db = /** @type {any} */ (b.reg.deps.db || /** @type {any} */ (b.reg).db);
  const acct = (/** @type {string} */ who) => db.prepare("SELECT id FROM sessions_accounts WHERE label = ?").get(`${who}'s Claude`).id;
  assert.ok(!(await b.as("bob")("stream.send", { chat: chat.id, text: "B-FIRST", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.equal((await answered(w, watcher, "B-FIRST", 60_000)).who, BOB);
  const thread = kitThread(b, chat.id);
  const run = () => db.prepare("SELECT account, opts FROM threads_runs WHERE id = ?").get(thread);
  const bobsAccount = run().account;
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: long, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => run().account === acct("carol"), "the thread to be on carol's account (her hop)", 30_000);
  return { chat, watcher, db, acct, thread, run, bobsAccount };
}

test("STOP: a hop's process stopped mid-turn puts the chat back on bob's account, says so once, and bob's next turn is answered on his own account", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const h = await carolMidHop(w, b, t, LONGER);
  assert.ok(JSON.parse(h.run().opts).switchPerson, "during the hop the record names carol");
  const stopped = await b.reg.call("threads.stop", { thread: h.thread }, "deck", { token: w.tokens.bob });
  assert.ok(!stopped.error, stopped.error && stopped.error.message);
  await until(() => h.run().account === h.bobsAccount, "the thread to be back on bob's account", 30_000);
  const o = JSON.parse(h.run().opts);
  assert.ok(o.switchPerson === undefined && o.hopBack === undefined && o.person === BOB, "the hop's person and record are gone: " + h.run().opts);
  await until(() => textOf(h.watcher.frames).includes("stopped before it finished"), "the room to be told", 20_000);
  assert.ok(!(await b.as("bob")("stream.send", { chat: h.chat.id, text: "B-AFTER-STOP", to: ["assistant:assistant"], cwd: w.work })).error);
  const next = await answered(w, h.watcher, "B-AFTER-STOP", 60_000);
  assert.equal(next.who, BOB);
  assert.equal(h.run().account, h.bobsAccount, "and it ran on bob's own account");
});

test("RESTART: the daemon dies with carol's hop pending: after the restart the chat is on bob's account, the room is told, and bob's next turn is answered on it", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b1 = await w.boot();
  const h = await carolMidHop(w, b1, t, LONGER);
  await w.crash(b1);
  const b2 = await w.boot();
  t.after(() => b2.stop().catch(() => {}));
  const db2 = /** @type {any} */ (b2.reg.deps.db || /** @type {any} */ (b2.reg).db);
  const row = () => db2.prepare("SELECT account, opts FROM threads_runs WHERE id = ?").get(h.thread);
  assert.equal(row().account, h.bobsAccount, "after the restart the record is on bob's account");
  const o = JSON.parse(row().opts);
  assert.ok(o.switchPerson === undefined && o.hopBack === undefined, "no hop record is left: " + row().opts);
  const bob = await b2.watch("bob", h.chat.id);
  assert.ok(!(await b2.as("bob")("stream.send", { chat: h.chat.id, text: "B-AFTER-RESTART", to: ["assistant:assistant"], cwd: w.work })).error);
  assert.equal((await answered(w, bob, "B-AFTER-RESTART", 60_000)).who, BOB);
  assert.equal(row().account, h.bobsAccount);
});

test("SEQ: bob, carol, bob, carol, ada take turns in one chat, each on their own account; no turn is refused, and each is answered", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  const order = [["bob", "B-ONE"], ["carol", "C-ONE"], ["bob", "B-TWO"], ["carol", "C-TWO"], ["ada", "A-ONE"]];
  const failures = [];
  for (const [who, words] of order) {
    const sent = await b.as(who)("stream.send", { chat: chat.id, text: words, to: ["assistant:assistant"], cwd: w.work });
    if (sent.error) { failures.push(`${who} ${words}: ${sent.error.code} ${sent.error.message}`); continue; }
    const got = await answered(w, watcher, words, 45_000).then((/** @type {any} */ x) => x, () => null);
    const person = { bob: BOB, carol: CAROL, ada: ADA }[/** @type {"bob"|"carol"|"ada"} */ (who)];
    if (got && got.who !== person) failures.push(`${who} ${words}: written under ${got.who}, not ${person}`);
    if (!got) failures.push(`${who} ${words}: not answered; notices: ${JSON.stringify(watcher.frames.filter(f => f.data && f.data.notice).map(f => String(f.data.text).slice(0, 120)).slice(-3))}`);
  }
  assert.deepEqual(failures, [], "every turn in the sequence was accepted and answered");
  // the same five turns, each with a tool call: the call is stamped with the session of the person whose turn it is, per message
  for (const [who, words] of order) {
    const from = w.stamped.length;
    const sent = await b.as(who)("stream.send", { chat: chat.id, text: `vyre threads.list {"limit":${1 + order.findIndex(o => o[1] === words)}}`, to: ["assistant:assistant"], cwd: w.work });
    assert.ok(!sent.error, `${who} ${words}: ${sent.error && sent.error.message}`);
    await until(() => w.stamped.length > from, `${who}'s tool call`, 60_000);
    await sleep(300);
    const person = { bob: BOB, carol: CAROL, ada: ADA }[/** @type {"bob"|"carol"|"ada"} */ (who)];
    assert.deepEqual([...new Set(w.stamped.slice(from).map(x => x.asker))], [person], `${who}'s tool call was stamped with ${who}'s session and nobody else's`);
    await sleep(1500);   // the turn ends and the thread is back before the next person speaks, as in the sequence above
  }
});

test("N1: Vyre's own notice while no turn is open is shown in the room as the system's words: no session is asked or opened, the chat does not go to failed, and the frame acts for nobody", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: "hello kit", to: ["assistant:assistant"], cwd: w.work })).error);
  await answered(w, watcher, "hello kit", 60_000);
  const thread = kitThread(b, chat.id);
  await until(async () => (await b.reg.call("threads.get", { thread, limit: 5 }, "cli")).data.thread.status === "idle", "the thread to be idle", 30_000);
  await sleep(500);
  const asked = w.asked.length, openedBefore = opened(w).length;
  const r = await b.reg.call("threads.notice", { thread, text: "NOTICE-OUTSIDE-A-TURN: a message was not sent" }, "module:stream");
  assert.ok(!r.error, JSON.stringify(r.error));
  await until(() => textOf(watcher.frames).includes("NOTICE-OUTSIDE-A-TURN"), "the notice to show in the room");
  const frame = watcher.frames.find(f => f.type === "chat.text-delta" && String(f.data.text).includes("NOTICE-OUTSIDE-A-TURN"));
  assert.equal(frame.author, "assistant:assistant", "it is the assistant member's thread that said it");
  assert.equal(frame.acts_for, undefined, "and it acts for nobody");
  assert.ok(watcher.frames.some(f => f.type === "chat.text-done" && f.data.message === frame.data.message), "the notice is closed");
  assert.ok(!watcher.frames.some(f => f.type === "chat.status" && f.data.state === "failed"), "the chat did not go to failed");
  assert.equal(w.asked.length, asked, "no session was asked for");
  assert.equal(opened(w).length, openedBefore, "and nothing was opened under any person");
});

test("N2: a notice inside a turn is shown through that turn's reply, as before", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: LONG, to: ["assistant:assistant"], cwd: w.work })).error);
  await until(() => textOf(watcher.frames).includes("SECRET"), "the running turn");
  const thread = kitThread(b, chat.id);
  assert.ok(!(await b.reg.call("threads.notice", { thread, text: "NOTICE-INSIDE-A-TURN" }, "module:stream")).error);
  await until(() => textOf(watcher.frames).includes("NOTICE-INSIDE-A-TURN"), "the notice inside the turn");
  const frame = watcher.frames.find(f => f.type === "chat.text-delta" && String(f.data.text).includes("NOTICE-INSIDE-A-TURN"));
  assert.ok(!String(frame.data.message).startsWith("notice."), "it went through the turn's reply, not the room's own notice path");
  assert.ok(!watcher.frames.some(f => f.type === "chat.status" && f.data.state === "failed"));
});

test("N3: a notice outside a turn follows the room's membership: a member who was removed before it does not receive it, one who is in the chat does", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watchBob = await b.watch("bob", chat.id), watchAda = await b.watch("ada", chat.id), watchCarol = await b.watch("carol", chat.id);
  assert.ok(!(await b.as("carol")("stream.send", { chat: chat.id, text: "hello kit", to: ["assistant:assistant"], cwd: w.work })).error);
  await answered(w, watchBob, "hello kit", 60_000);
  const thread = kitThread(b, chat.id);
  await until(async () => (await b.reg.call("threads.get", { thread, limit: 5 }, "cli")).data.thread.status === "idle", "the thread to be idle", 30_000);
  await w.C.change(w.chains.bob, chat.id, { remove_people: [ADA] });
  // the stream learns of the removal at the next call a person makes into the room (its mirror of the kernel's list), as for every other frame
  const opened = await b.as("bob")("stream.open", { chat: chat.id });
  assert.ok(!opened.error, JSON.stringify(opened.error));
  await until(() => watchBob.frames.some(f => f.type === "chat.participant-left"), "the stream to know ada left");
  assert.ok(!(await b.reg.call("threads.notice", { thread, text: "NOTICE-AFTER-ADA-LEFT" }, "module:stream")).error);
  await until(() => textOf(watchBob.frames).includes("NOTICE-AFTER-ADA-LEFT") && textOf(watchCarol.frames).includes("NOTICE-AFTER-ADA-LEFT"), "the people in the chat to get the notice");
  await sleep(500);
  assert.ok(!textOf(watchAda.frames).includes("NOTICE-AFTER-ADA-LEFT"), "ada left before it and does not receive it");
});

test("RD1: stream.read gives a member in the chat the other person's message and the AI's answer from the start, in order and bounded; her join floor holds; a person not in the chat is refused", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watcher = await b.watch("bob", chat.id);
  const sent = await b.as("bob")("stream.send", { chat: chat.id, text: "R1-hello", to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!sent.error, sent.error && sent.error.message);
  await until(() => /R1-hello/.test(textOf(watcher.frames)), "the AI's answer to R1-hello", 60_000);
  const read = async (/** @type {string} */ who, /** @type {any} */ input) => b.as(who)("stream.read", { chat: chat.id, ...input });
  const r = await read("carol", { from: 0 });
  assert.ok(!r.error, r.error && r.error.message);
  const frames = r.data.frames;
  assert.ok(frames.some((/** @type {any} */ f) => f.type === "chat.user-message" && String(f.data.text) === "R1-hello"), "carol reads bob's message");
  assert.match(textOf(frames), /R1-hello/, "and the AI's answer to it");
  assert.deepEqual(frames.map((/** @type {any} */ f) => f.cur), [...frames.map((/** @type {any} */ f) => f.cur)].sort((x, y) => x - y), "in order");
  assert.equal(r.data.viewer, `person:${CAROL}`, "drawn for her");
  assert.ok(r.data.next >= frames[frames.length - 1].cur, "next is the cursor to ask from");
  // bounded: a limit of 3 gives at most 3, a huge limit at most 200, and asking from `next` gives the rest with no repeat
  assert.ok((await read("carol", { from: 0, limit: 3 })).data.frames.length <= 3, "a small limit holds");
  assert.ok((await read("carol", { from: 0, limit: 100000 })).data.frames.length <= 200, "the cap is 200 frames a call");
  const tail = await read("carol", { from: r.data.next });
  assert.equal(tail.data.frames.length, 0, "nothing after the head");
  const behind = await read("carol", { from: r.data.head + 50 });
  assert.equal(behind.data.reset, "ahead", "a cursor ahead of the log says reset");
  // a person who is not in the chat is refused in words
  const outsider = await read("ada", { from: 0 });
  assert.ok(outsider.error, "ada is not in the chat");
  assert.ok(!JSON.stringify(outsider).includes("R1-hello"), "and sees none of it");
  // her join floor: ada joins now; what was said before her join comes as cursor-only placeholders, not words
  await w.C.change(w.chains.bob, chat.id, { add_people: [ADA] });
  const late = await read("ada", { from: 0 });
  assert.ok(!late.error, late.error && late.error.message);
  assert.ok(!JSON.stringify(late.data.frames).includes("R1-hello"), "ada reads none of what was said before she joined");
  assert.ok(late.data.frames.some((/** @type {any} */ f) => f.type === "chat.hidden"), "she gets cursor-only placeholders for it");
});
