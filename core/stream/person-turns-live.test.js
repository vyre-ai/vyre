// @ts-check
// (copied from group-ks-live.test.js) Step 7 of the E2E run, as far as it can run without a switchboard that carries the chat (chat 0.3 tasks S and T). What is REAL here: the kernel (createKernel: surfaces, chats, the room
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
async function world(t, opts = {}) {
  const k = await createKernel({ space: SPACE, owner: BOB, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: BOB, path: "direct", session: "s" });   // bob is the owner of this Space: his turns may run on the machine's own login, everyone else's only on their own sign-in
  const g = k.gateway.grants;
  for (const [p, role] of [[CAROL, "member"], [ADA, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const dev = (/** @type {string} */ person, /** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const chains = { bob: dev(BOB, "d-b"), carol: dev(CAROL, "d-c"), ada: dev(ADA, "d-a") };
  /** @type {Record<string, string>} */ const tokens = {};
  for (const [n, c] of Object.entries(chains)) tokens[n] = (await k.surfaces.open(c, {})).token;
  const direct = new Map(Object.entries(tokens).map(([n, tok]) => [tok, /** @type {any} */ (chains)[n]]));
  const blank = { on: Boolean(opts.blankOwner) };   // the test turns it on once the thread exists: a kernel whose owner cannot be read
  const kernelFor = (/** @type {any} */ m) => { const h = k.kernelFor(m); return Object.freeze({ ...h, get owner() { return blank.on ? "" : h.owner; }, chain: async (/** @type {any} */ meta) => (meta && direct.get(meta.token)) || h.chain(meta) }); };
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
  /** What the Switchboard asked the daemon to open: the thread, the chat and the asker. @type {any[]} */ const asked = [];
  /** What the stream asked of the seam, in order, per thread: beginTurn must come before the first appendOpen. @type {string[]} */ const seamCalls = [];

  /** Start the stream the way the daemon does: the Registry is handed the seam as deps.kernelThreads, over a createKernelSessions that has the kernel's chats and the durable turns. */
  // The bus is the kernel's log, which outlives a restart: every boot in this test shares one.
  const bus = new Events();
  async function boot(/** @type {{ personChainFor?: (p: string) => Promise<any>, timeoutMs?: number }} */ o = {}) {
    // the kernel's chats as the seam holds them, with the turn-begin counted: a turn must begin exactly once, when its session opens
    const kc = /** @type {any} */ (k.kernelFor({ name: "kernel-sessions" })).chats;
    const ks = createKernelSessions({ kernel: k, turns, chats: Object.freeze({ ...kc, beginTurn: async (/** @type {string} */ tok) => { seamCalls.push("BEGIN"); return kc.beginTurn(tok); } }) });
    const db = open(p.db);
    const events = bus;
    const reg = new Registry({ db, events, config: { role: "box", stream: { resumeWaitSeconds: o.timeoutMs ? o.timeoutMs / 1000 : 60 }, sessions: { install: false }, transcripts: [] }, paths: p, handler: () => (/** @type {any} */ _q, /** @type {any} */ r) => { r.writeHead(404); r.end(); }, log: process.env.E2E_DEBUG ? (/** @type {string} */ m) => console.error("LOG", m) : () => {}, kernelFor });
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
      if (process.env.E2E_DEBUG) console.error("KSOPEN", JSON.stringify({ chat, asker: q.asker, agent: q.agent }));
      // as the daemon does (core/daemon/index.js kernelSession): a run with no agent in a chat is a model slot, and its token's agent hop is the slot id
      const agent = q.agent || (chat && q.rec && typeof q.rec.slot === "string" && q.rec.slot.startsWith("model:") ? q.rec.slot : undefined);
      const s = await ks.open({ chain: person, ...(chat ? { chat } : {}), ...(agent ? { agent } : {}), ...(agent && agent.startsWith("model:") ? { slotOpen: true } : {}), thread: q.thread });
      return { token: ks.tokenFor(s.id), end: () => ks.end(s.id) };
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
      const c = connect({ open: async ({ from }) => { const r = await as(who)("stream.open", { chat: session, from }); assert.ok(!r.error, r.error && r.error.message); return wsDuplex(`ws://127.0.0.1:${port}${r.data.path}`); }, onFrame: f => frames.push(f), backoff: { base: 5, cap: 10 } });
      t.after(() => c.close());
      return { frames, close: () => c.close() };
    };
    return { ks, reg, realCall: reg.call.bind(reg), as, port, stop, watch, stream: () => reg.modules.get("stream")?.handle, events };
  }
  /** A daemon that dies mid-turn: what kill -9 leaves is the durable turn store as it was (a graceful stop ends each session, which forgets its turn, so put them back). */
  const crash = async (/** @type {{ stop: () => Promise<void> }} */ b) => { const snap = new Map(kept); await b.stop(); for (const [x, r] of snap) kept.set(x, r); };
  return { k, blank, chains, tokens, kept, crash, boot, gaveUp, asked, work, seamCalls, paths: p, C: g.chats };
}
const textOf = (/** @type {any[]} */ frames) => frames.filter(f => f.type === "chat.text-delta" && !f.data.reasoning).map(f => f.data.text).join("");
const kitThread = (/** @type {any} */ b, /** @type {string} */ chat) => String(b.stream().groups.member(chat, "assistant:assistant").thread);


async function world0(w, t) { const b = await w.boot(); t.after(() => b.stop().catch(() => {})); return b; }

/** A stand-in `codex-acp` first on PATH: the fake ACP agent, signed in as a login account. */
function withCodex(t, root) {
  const bin = path.join(root, "shim");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.resolve(CORE, "sessions", "testing", "fake-acp.js"), path.join(bin, "codex-acp"));
  const saved = { PATH: process.env.PATH, FAKE_ACP_STORE: process.env.FAKE_ACP_STORE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACP_STORE = path.join(root, "acp-store");
  fs.mkdirSync(process.env.FAKE_ACP_STORE, { recursive: true });
  Object.assign(process.env, { FAKE_ACP_EXTRA_MODE: "workspace-write", FAKE_ACP_START_MODE: "agent" });
  t.after(() => { for (const k of ["FAKE_ACP_EXTRA_MODE", "FAKE_ACP_START_MODE"]) delete process.env[k]; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test("G04: bob on Claude says a code word; carol asks on her own AI (Codex) and her AI is handed the whole conversation, so it can answer from bob's turn", async t => {
  const w = await world(t);
  withCodex(t, w.work);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const carol = await b.watch("carol", chat.id);
  // codex is signed in on this box
  const added = await b.reg.call("sessions.accounts.add", { provider: "codex", label: "Carols Codex", kind: "login" }, "deck", { token: w.tokens.carol });
  assert.ok(!added.error, added.error && added.error.message);
  b.reg.deps.db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), added.data.id);
  // bob, on the thread's own provider (Claude), says a fact only his turn holds
  const first = await b.as("bob")("stream.send", { chat: chat.id, text: "the code word is AMBER-92", to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!first.error, first.error && `${first.error.code} ${first.error.message}`);
  await until(() => textOf(carol.frames).includes("echo: the code word is AMBER-92"), "claude's answer to bob", 120_000);
  const thread = kitThread(b, chat.id);
  // carol asks on Codex
  const second = await b.as("carol")("stream.send", { chat: chat.id, text: "what was the code word?", to: ["assistant:assistant"], account: "codex", cwd: w.work });
  assert.ok(!second.error, second.error && `${second.error.code} ${second.error.message}`);
  await until(() => /Vyre continuation/.test(textOf(carol.frames)), "codex's answer to carol", 120_000).catch(async e => { const ev = (await b.reg.call("threads.get", { thread, limit: 200 }, "cli")).data.events; throw new Error(`${e.message}: ${JSON.stringify(ev.slice(-14).map((/** @type {any} */ x) => [x.type, String(x.payload && (x.payload.text || x.payload.reason || x.payload.error || x.payload.to || "")).slice(0, 100)]))} frames ${JSON.stringify(carol.frames.slice(-6).map(f => [f.type, JSON.stringify(f.data).slice(0, 100)]))}`); });
  const said = textOf(carol.frames);
  assert.match(said, /AMBER-92/, "carol's AI was handed bob's turn: the code word is in what it received");
  assert.match(said, /what was the code word\?/);
  const events = async () => (await b.reg.call("threads.get", { thread, limit: 200 }, "cli")).data.events;
  // the thread goes back to its own provider once the one turn has ended, which is after the reply's last word: wait for it, not for the clock
  await until(async () => (await events()).some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.reason === "back" && e.payload.to === "claude"), "the thread going back to its own provider", 30_000).catch(() => {});
  const ev = await events();
  assert.ok(ev.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.to === "codex" && e.payload.reason === "once"), "the turn ran on carol's provider for that one turn");
  assert.ok(ev.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.reason === "back" && e.payload.to === "claude"), "and the thread went back to its own");
  await b.stop();
});

test("G04: two people each with their own Codex sign-in: the thread starts on bob's, and carol's message runs on carol's own account with bob's turn in what it is handed", async t => {
  const w = await world(t);
  withCodex(t, w.work);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const carol = await b.watch("carol", chat.id);
  const own = async (/** @type {string} */ who, /** @type {string} */ label) => {
    const r = await b.reg.call("sessions.accounts.add", { provider: "codex", label, kind: "login" }, "deck", { token: w.tokens[who] });
    assert.ok(!r.error, r.error && r.error.message);
    b.reg.deps.db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), r.data.id);
    return r.data.id;
  };
  const bobsAcct = await own("bob", "Bob's Codex"), carolsAcct = await own("carol", "Carol's Codex");
  assert.notEqual(bobsAcct, carolsAcct);
  // bob speaks first, on Codex (his chip): the thread starts on his account
  const first = await b.as("bob")("stream.send", { chat: chat.id, text: "the code word is AMBER-92", to: ["assistant:assistant"], account: `codex:${bobsAcct}`, cwd: w.work });
  assert.ok(!first.error, first.error && `${first.error.code} ${first.error.message}`);
  await until(() => /AMBER-92/.test(textOf(carol.frames)), "bob's turn", 120_000);
  const thread = kitThread(b, chat.id);
  assert.equal((await b.reg.call("threads.get", { thread }, "cli")).data.thread.account, bobsAcct, "the thread is on bob's account");
  // carol sends with no chip: her own Codex sign-in is hers to use
  const second = await b.as("carol")("stream.send", { chat: chat.id, text: "what was the code word?", to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!second.error, second.error && `${second.error.code} ${second.error.message}`);
  await until(() => /what was the code word\?/.test(textOf(carol.frames).split("echo:").pop() || ""), "carol's answer", 120_000);
  const ev = (await b.reg.call("threads.get", { thread, limit: 300 }, "cli")).data.events;
  assert.ok(ev.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.reason === "once" && e.payload.account === carolsAcct), "carol's turn ran on carol's own account");
  assert.match(textOf(carol.frames), /AMBER-92[\s\S]*what was the code word/, "and her AI was handed bob's turn");
  await b.stop();
});

/** Two Codex sign-ins, bob's and carol's, each held by its own person; bob's thread started on his. */
async function bobsThread(t, opts = {}) {
  const w = await world(t, opts);
  withCodex(t, w.work);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL, ADA], assistants: ["assistant"] });
  const watchCarol = await b.watch("carol", chat.id);
  const own = async (/** @type {string} */ who, /** @type {string} */ label) => {
    const r = await b.reg.call("sessions.accounts.add", { provider: "codex", label, kind: "login" }, "deck", { token: w.tokens[who] });
    assert.ok(!r.error, r.error && r.error.message);
    b.reg.deps.db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), r.data.id);
    return r.data.id;
  };
  const bobsAcct = await own("bob", "Bob's Codex");
  const first = await b.as("bob")("stream.send", { chat: chat.id, text: "the code word is AMBER-92", to: ["assistant:assistant"], account: `codex:${bobsAcct}`, cwd: w.work });
  assert.ok(!first.error, first.error && `${first.error.code} ${first.error.message}`);
  await until(() => /AMBER-92/.test(textOf(watchCarol.frames)), "bob's turn", 120_000);
  const thread = kitThread(b, chat.id);
  const events = async () => (await b.reg.call("threads.get", { thread, limit: 400 }, "cli")).data.events;
  await until(async () => (await events()).some((/** @type {any} */ e) => e.type === "thread.finished"), "bob's turn to end", 60_000);
  return { w, b, chat, own, bobsAcct, thread, events, watchCarol };
}

test("G04: a member with no sign-in of their own is never run on another member's: the turn is refused in words and nothing reaches bob's account", async t => {
  const r = await bobsThread(t);
  const before = (await r.events()).length;
  const asked = await r.b.as("carol")("stream.send", { chat: r.chat.id, text: "what was the code word?", to: ["assistant:assistant"], cwd: r.w.work });
  assert.ok(!asked.error, "the stream takes the message; the Switchboard refuses the turn");
  await sleep(1500);
  const ev = (await r.events()).slice(before);
  assert.ok(!ev.some((/** @type {any} */ e) => e.type === "thread.sent" && /what was the code word/.test(String(e.payload.text))), "carol's words were never handed to the thread, so never to bob's sign-in");
  assert.ok(!ev.some((/** @type {any} */ e) => e.type === "thread.provider"), "no switch of account happened");
  const direct = await r.b.reg.call("threads.send", { thread: r.thread, text: "x", chat: r.chat.id, asker: CAROL }, "module:stream", {});
  assert.ok(direct.error && /sign-in/.test(direct.error.message), JSON.stringify(direct.error));
  assert.equal(direct.error && direct.error.code, "account_required");
  await r.b.stop();
});

test("G04: a chip may name only an account that serves the sender: carol cannot pick bob's", async t => {
  const r = await bobsThread(t);
  await r.own("carol", "Carol's Codex");
  const before = (await r.events()).length;
  const asked = await r.b.as("carol")("stream.send", { chat: r.chat.id, text: "use his", to: ["assistant:assistant"], account: `codex:${r.bobsAcct}`, cwd: r.w.work });
  assert.ok(!asked.error);
  await sleep(1500);
  const ev = (await r.events()).slice(before);
  assert.ok(!ev.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.account === r.bobsAcct), "no turn of carol's ran on bob's account");
  assert.ok(!ev.some((/** @type {any} */ e) => e.type === "thread.sent" && /use his/.test(String(e.payload.text))));
  await r.b.stop();
});

test("G04: a turn that arrives while another is running waits behind it, then runs on the sender's own account", async t => {
  const w = await world(t);
  withCodex(t, w.work);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const carol = await b.watch("carol", chat.id);
  const added = await b.reg.call("sessions.accounts.add", { provider: "codex", label: "Carols Codex", kind: "login" }, "deck", { token: w.tokens.carol });
  b.reg.deps.db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), added.data.id);
  const long = "SECRET " + Array(500).fill("word").join(" ");
  const first = await b.as("bob")("stream.send", { chat: chat.id, text: long, to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!first.error, first.error && first.error.message);
  await until(() => textOf(carol.frames).includes("SECRET"), "bob's reply to start", 30_000);
  const second = await b.as("carol")("stream.send", { chat: chat.id, text: "my question", to: ["assistant:assistant"], account: "codex", cwd: w.work });
  assert.ok(!second.error, second.error && `${second.error.code} ${second.error.message}`);
  const thread = kitThread(b, chat.id);
  await until(async () => (await b.reg.call("threads.get", { thread, limit: 400 }, "cli")).data.events.some((/** @type {any} */ e) => e.type === "thread.queued"), "carol's turn to be queued", 30_000);
  await until(async () => (await b.reg.call("threads.get", { thread, limit: 400 }, "cli")).data.events.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.reason === "once" && e.payload.account === added.data.id), "carol's turn to run on her own account after bob's", 150_000);
  await b.stop();
});

// Review of 122f96c9c (rc1-d, 11 Oct): the same rule through every way a message reaches the Switchboard, on the real one.
const PNG = { media_type: "image/png", data: "iVBORw0KGgo=" };
const sentIn = (/** @type {any[]} */ ev, /** @type {RegExp} */ re) => ev.some(e => e.type === "thread.sent" && re.test(String(e.payload.text)));
const ranOn = (/** @type {any[]} */ ev, /** @type {string} */ acct) => ev.some(e => e.type === "thread.provider" && e.payload.account === acct);

test("review A: a member with no sign-in who sends a picture on a live thread is refused in words, not run on the thread's account", async t => {
  const r = await bobsThread(t);
  const before = (await r.events()).length;
  const sent = await r.b.reg.call("threads.send", { thread: r.thread, text: "look at this picture", chat: r.chat.id, asker: CAROL, images: [PNG] }, "module:stream", {});
  assert.equal(sent.error && sent.error.code, "account_required", JSON.stringify(sent));
  assert.match(sent.error.message, /sign-in/);
  await sleep(500);
  const ev = (await r.events()).slice(before);
  assert.ok(!sentIn(ev, /look at this picture/), "her words never reached the thread");
  assert.ok(!ev.some(e => e.type === "thread.provider"), "no turn ran");
  await r.b.stop();
});

test("review A: a member WITH a sign-in of her own who sends a picture is refused with the images words: the picture never runs on bob's account", async t => {
  const r = await bobsThread(t);
  const hers = await r.own("carol", "Carol's Codex 2");
  const before = (await r.events()).length;
  const sent = await r.b.reg.call("threads.send", { thread: r.thread, text: "look at this picture", chat: r.chat.id, asker: CAROL, images: [PNG] }, "module:stream", {});
  assert.equal(sent.error && sent.error.code, "bad_input", JSON.stringify(sent));
  assert.match(sent.error.message, /images cannot go to another provider's one-turn ask/);
  await sleep(500);
  const ev = (await r.events()).slice(before);
  assert.ok(!sentIn(ev, /look at this picture/) && !ranOn(ev, r.bobsAcct) && !ranOn(ev, hers), "nothing was sent, on bob's account or any other");
  await r.b.stop();
});

test("review B: a provider-only chip (@codex, no account) from a member with no sign-in is refused; an outsider's is refused as not in the chat", async t => {
  const r = await bobsThread(t);
  const before = (await r.events()).length;
  const chip = { kind: "account", id: "codex" };
  const sent = await r.b.reg.call("threads.send", { thread: r.thread, text: "chip without an account", chat: r.chat.id, asker: CAROL, mentions: [chip] }, "module:stream", {});
  assert.equal(sent.error && sent.error.code, "account_required", JSON.stringify(sent));
  const out = await r.b.reg.call("threads.send", { thread: r.thread, text: "chip from outside", chat: r.chat.id, asker: "per_mallory", mentions: [chip] }, "module:stream", {});
  assert.equal(out.error && out.error.code, "not_found", JSON.stringify(out));
  await sleep(500);
  const ev = (await r.events()).slice(before);
  assert.ok(!sentIn(ev, /chip without an account|chip from outside/), "neither reached the thread, so neither ran on bob's account");
  await r.b.stop();
});

test("review B: a provider-only chip from a member WITH a sign-in runs on her own account, never the thread's", async t => {
  const r = await bobsThread(t);
  const hers = await r.own("carol", "Carol's Codex 3");
  const before = (await r.events()).length;
  const sent = await r.b.reg.call("threads.send", { thread: r.thread, text: "chip with my own account", surface: "deck", chat: r.chat.id, asker: CAROL, mentions: [{ kind: "account", id: "codex" }] }, "module:stream", {});
  assert.ok(!sent.error, JSON.stringify(sent.error));
  await until(async () => ranOn((await r.events()).slice(before), hers), "the turn on carol's own account", 60_000);
  assert.ok(!ranOn((await r.events()).slice(before), r.bobsAcct), "and not on bob's");
  await r.b.stop();
});

test("review C: a kernel whose owner cannot be read refuses a member with no sign-in of her own on a thread that names no account (fails closed)", async t => {
  const w = await world(t);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const watch = await b.watch("carol", chat.id);
  const first = await b.as("bob")("stream.send", { chat: chat.id, text: "the code word is AMBER-92", to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!first.error, first.error && first.error.message);
  await until(() => textOf(watch.frames).includes("echo: the code word is AMBER-92"), "claude's answer to bob", 60_000);
  const thread = kitThread(b, chat.id);
  const events = async () => (await b.reg.call("threads.get", { thread, limit: 400 }, "cli")).data.events;
  await until(async () => (await events()).some((/** @type {any} */ e) => e.type === "thread.finished"), "bob's turn to end", 60_000);
  w.blank.on = true;
  const before = (await events()).length;
  const sent = await b.reg.call("threads.send", { thread, text: "who owns this?", surface: "deck", chat: chat.id, asker: CAROL }, "module:stream", {});
  assert.equal(sent.error && sent.error.code, "account_required", JSON.stringify(sent));
  await sleep(500);
  assert.ok(!sentIn((await events()).slice(before), /who owns this/), "nothing reached the thread, so nothing ran on the machine's own login");
  await b.stop();
});

test("review D: an asker who left the chat while their message waited gets no turn: the row is dropped with the words, and nothing is sent without their token", async t => {
  const w = await world(t);
  withCodex(t, w.work);
  const b = await world0(w, t);
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["assistant"] });
  const carol = await b.watch("carol", chat.id);
  const added = await b.reg.call("sessions.accounts.add", { provider: "codex", label: "Carols Codex", kind: "login" }, "deck", { token: w.tokens.carol });
  b.reg.deps.db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), added.data.id);
  const first = await b.as("bob")("stream.send", { chat: chat.id, text: "SECRET " + Array(500).fill("word").join(" "), to: ["assistant:assistant"], cwd: w.work });
  assert.ok(!first.error, first.error && first.error.message);
  await until(() => textOf(carol.frames).includes("SECRET"), "bob's reply to start", 30_000);
  const second = await b.as("carol")("stream.send", { chat: chat.id, text: "my question", to: ["assistant:assistant"], account: "codex", cwd: w.work });
  assert.ok(!second.error, second.error && `${second.error.code} ${second.error.message}`);
  const thread = kitThread(b, chat.id);
  const events = async () => (await b.reg.call("threads.get", { thread, limit: 400 }, "cli")).data.events;
  await until(async () => (await events()).some((/** @type {any} */ e) => e.type === "thread.queued"), "carol's turn to be queued", 30_000);
  await w.C.change(w.chains.bob, chat.id, { remove_people: [CAROL] });
  await until(async () => (await events()).some((/** @type {any} */ e) => e.type === "thread.text" && /no longer in this chat/.test(String(e.payload.text))), "the waiting message to be dropped in words", 150_000);
  await sleep(1000);
  const ev = await events();
  assert.ok(!ranOn(ev, added.data.id), "no turn ran on carol's account");
  assert.ok(!sentIn(ev.filter((/** @type {any} */ e) => e.payload && e.payload.via === "turn"), /my question/), "her words were never handed to the thread");
  const row = b.reg.deps.db.prepare("SELECT via, delivered_at FROM threads_inbox WHERE thread = ? AND text = 'my question'").get(thread);
  assert.equal(row && row.via, "dropped", "the row is marked dropped, not delivered");
  await b.stop();
});
