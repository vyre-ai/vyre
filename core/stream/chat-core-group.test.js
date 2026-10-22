// @ts-check
// Checklist line 3: two people, two agents. An @mention picks who answers. Each answer runs on the
// asker's own account, and the group frame carries that provider's mark. The rig is the same one
// person-turns-live uses (kernel, stream, the real Switchboard, the fake Claude and Codex children).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
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
import { lendKey } from "../daemon/lend-key.js";
import { callLend } from "../modules/lend-call.js";
import { connect, wsDuplex } from "./client.js";
import { FAKE } from "../sessions/testing/boot.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol";
const used = new Set();
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await sleep(20); } throw new Error(`timed out waiting for ${what}`); };
/** @type {string[]} */ const LOGS = [];

async function world(t) {
  const k = await createKernel({ space: SPACE, owner: BOB, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: BOB, path: "direct", session: "s" });
  const g = k.gateway.grants;
  const role = { person: CAROL, role: "member" };
  await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${CAROL}`) });
  for (const id of ["kit", "juno"]) {
    const actor = { kind: "agent", id, space: SPACE };
    await g.addActor(owner, actor, { presence: proof("grants.role", { actor }, `vyre://${SPACE}/member/${id}`) });
  }
  const dev = (/** @type {string} */ person, /** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const chains = { bob: dev(BOB, "d-b"), carol: dev(CAROL, "d-c") };
  /** @type {Record<string, string>} */ const tokens = {};
  for (const [n, c] of Object.entries(chains)) tokens[n] = (await k.surfaces.open(c, {})).token;
  const direct = new Map(Object.entries(tokens).map(([n, tok]) => [tok, /** @type {any} */ (chains)[n]]));
  const kernelFor = (/** @type {any} */ m) => { const h = k.kernelFor(m); return Object.freeze({ ...h, chain: async (/** @type {any} */ meta) => (meta && direct.get(meta.token)) || h.chain(meta) }); };
  /** @type {Map<string, any>} */ const kept = new Map();
  const turns = { durable: true, get: (/** @type {string} */ x) => kept.get(x), set: (/** @type {string} */ x, /** @type {any} */ r) => kept.set(x, r), delete: (/** @type {string} */ x) => kept.delete(x), all: () => /** @type {[string, any][]} */ ([...kept]) };
  const p = config.ensure(tempHome(t));
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-stream-ks-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const saved = { FAKE_CLAUDE_DELTA_MS: process.env.FAKE_CLAUDE_DELTA_MS, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, VYRE_SESSIONS_THREAD_SOCKET: process.env.VYRE_SESSIONS_THREAD_SOCKET, VYRE_SESSIONS_SPAWNER: process.env.VYRE_SESSIONS_SPAWNER };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSIONS_THREAD_SOCKET: "on", VYRE_SESSIONS_SPAWNER: "off", FAKE_CLAUDE_DELTA_MS: "20" });
  t.after(() => { for (const [k2, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k2]; else process.env[k2] = v; } });
  const personChainFor = async (/** @type {string} */ person) => k.chains.fromFacts({ kind: "device", device_key_id: "vyred", person, path: "direct" });
  const bus = new Events();
  async function boot() {
    const kc = /** @type {any} */ (k.kernelFor({ name: "kernel-sessions" })).chats;
    const ks = createKernelSessions({ kernel: k, turns, chats: kc });
    const db = open(p.db);
    const reg = new Registry({ db, events: bus, config: { role: "box", stream: { resumeWaitSeconds: 60 }, sessions: { install: false }, transcripts: [] }, paths: p, handler: () => (/** @type {any} */ _q, /** @type {any} */ r) => { r.writeHead(404); r.end(); }, log: (/** @type {string} */ m) => { LOGS.push(String(m)); if (LOGS.length > 80) LOGS.shift(); }, kernelFor });
    { const orig = reg.call.bind(reg); reg.call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ m) => orig(tool, input, caller, m !== undefined ? m : (/^(cli|deck|local|capsule)$/.test(String(caller)) ? { kernelFacts: { kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "s" } } : undefined)); }
    reg.deps.kernelThreads = Object.freeze({
      forThread: (/** @type {string} */ thread) => ks.forThread(thread),
      reopenPending: (/** @type {any} */ a) => ks.reopenPending({ personChainFor, ...a }),
    });
    reg.deps.lendKey = lendKey({ kernel: k, personChainFor, callLend: (/** @type {any} */ i, /** @type {any} */ x) => callLend(reg, i, x) });
    reg.deps.sandbox = { off: true };
    reg.deps.kernelSession = async (/** @type {{ thread: string, agent: string | null, rec?: any, chat?: string, asker?: string, probe?: boolean }} */ q) => {
      const person = k.chains.fromFacts({ kind: "session_person", person: q.asker || OWNER, session: `thread:${q.thread}`, vouched: true });
      const chat = q.chat || (q.rec && typeof q.rec.chat === "string" ? q.rec.chat : undefined);
      if (q.probe) { await g.chats.read(person, /** @type {string} */ (chat)); return { token: () => "", end: async () => {} }; }
      const agent = q.agent || (chat && q.rec && typeof q.rec.slot === "string" && q.rec.slot.startsWith("model:") ? q.rec.slot : undefined);
      const s = await ks.open({ chain: person, ...(chat ? { chat } : {}), ...(agent ? { agent } : {}), ...(agent && agent.startsWith("model:") ? { slotOpen: true } : {}), thread: q.thread });
      return { token: ks.tokenFor(s.id), end: () => ks.end(s.id) };
    };
    await reg.start(discover([CORE]).filter((f) => f.manifest && (["stream", "threads", "sessions"].includes(f.manifest.name))), { role: "box" });
    for (const m of ["sessions", "threads", "stream"]) assert.equal(reg.modules.get(m)?.state, "running", reg.modules.get(m)?.error);
    const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
    s.on("upgrade", (req, socket, head) => { reg.upgrades.get("stream/session").handler(req, socket, head, { caller: "deck", url: new URL(req.url || "/", "http://vyred") }); });
    await new Promise((r) => s.listen(0, "127.0.0.1", () => r(undefined)));
    const port = /** @type {any} */ (s.address()).port;
    const as = (/** @type {string} */ who) => (/** @type {string} */ tool, /** @type {any} */ input) => reg.call(tool, input, "deck", { token: tokens[who] });
    const stop = async () => { s.closeAllConnections(); s.close(); await reg.stop(); db.close(); };
    const watch = async (/** @type {string} */ who, /** @type {string} */ session) => {
      /** @type {any[]} */ const frames = [];
      const c = connect({ open: async ({ from }) => { const r = await as(who)("stream.open", { chat: session, from }); assert.ok(!r.error, r.error && r.error.message); return wsDuplex(`ws://127.0.0.1:${port}${r.data.path}`); }, onFrame: (f) => frames.push(f), backoff: { base: 5, cap: 10 } });
      t.after(() => c.close());
      return { frames, close: () => c.close() };
    };
    return { reg, as, stop, watch, stream: () => reg.modules.get("stream")?.handle };
  }
  return { k, chains, tokens, boot, work, C: g.chats };
}

function withCodex(t, root) {
  const bin = path.join(root, "shim");
  fs.mkdirSync(bin, { recursive: true });
  const acp = path.resolve(CORE, "sessions", "testing", "fake-acp.js");
  fs.chmodSync(acp, 0o755);
  fs.symlinkSync(acp, path.join(bin, "codex-acp"));
  const saved = { PATH: process.env.PATH, FAKE_ACP_STORE: process.env.FAKE_ACP_STORE, FAKE_ACP_LOG: process.env.FAKE_ACP_LOG };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACP_STORE = path.join(root, "acp-store");
  fs.mkdirSync(process.env.FAKE_ACP_STORE, { recursive: true });
  process.env.FAKE_ACP_LOG = path.join(root, "acp.log");
  Object.assign(process.env, { FAKE_ACP_EXTRA_MODE: "workspace-write", FAKE_ACP_START_MODE: "agent" });
  t.after(() => { for (const k of ["FAKE_ACP_EXTRA_MODE", "FAKE_ACP_START_MODE"]) delete process.env[k]; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

const deltas = (/** @type {any[]} */ frames, /** @type {string} */ author, /** @type {string} */ word) => frames.filter((f) => f.type === "chat.text-delta" && f.author === author && f.data && !f.data.reasoning && String(f.data.text || "").includes(word));

test("chat core: two people and two agents, an @mention picks who answers, and each answer runs on the asker's own account with that provider's mark", { timeout: 240_000 }, async (t) => {
  const prevDirect = process.env.VYRE_LEGACY_DIRECT_MODEL;
  process.env.VYRE_LEGACY_DIRECT_MODEL = "1";
  t.after(() => { if (prevDirect === undefined) delete process.env.VYRE_LEGACY_DIRECT_MODEL; else process.env.VYRE_LEGACY_DIRECT_MODEL = prevDirect; });
  const w = await world(t);
  withCodex(t, w.work);
  const b = await w.boot();
  t.after(() => b.stop().catch(() => {}));
  const chat = await w.C.create(w.chains.bob, { people: [CAROL], assistants: ["kit", "juno"] });
  const carol = await b.watch("carol", chat.id);
  const added = await b.reg.call("sessions.accounts.add", { provider: "codex", label: "Member Codex", kind: "login" }, "deck", { token: w.tokens.carol });
  assert.ok(!added.error, added.error && added.error.message);
  b.reg.deps.db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), added.data.id);

  const quiet = await b.as("bob")("stream.send", { chat: chat.id, text: "hello the room", cwd: w.work });
  assert.equal(quiet.error, undefined, quiet.error && `${quiet.error.code} ${quiet.error.message}`);
  assert.deepEqual(quiet.data.routed, [], "with two people, an agent that was not mentioned stays quiet");

  const askKit = await b.as("carol")("stream.send", { chat: chat.id, text: "@kit the word is QUINCE-7", cwd: w.work });
  assert.equal(askKit.error, undefined, askKit.error && `${askKit.error.code} ${askKit.error.message}`);
  assert.deepEqual(askKit.data.routed, ["assistant:kit"]);
  await until(() => deltas(carol.frames, "assistant:kit", "QUINCE-7").length > 0, "kit's answer", 120_000).catch((e) => { throw new Error(`${e.message} log ${JSON.stringify(LOGS.slice(-30))} frames ${JSON.stringify(carol.frames.slice(-8).map((f) => [f.type, f.author, String(JSON.stringify(f.data)).slice(0, 220)]))}`); });
  const kitFrames = deltas(carol.frames, "assistant:kit", "QUINCE-7");
  assert.ok(kitFrames.every((f) => f.data.provider === "codex"), JSON.stringify(kitFrames.map((f) => f.data.provider)));
  assert.ok(kitFrames.every((f) => f.acts_for === `person:${CAROL}`));
  const kit = b.stream().groups.member(chat.id, "assistant:kit");
  assert.ok(kit && kit.thread, "kit answers on its own thread");
  const kitEv = (await b.reg.call("threads.get", { thread: kit.thread, limit: 300 }, "cli")).data;
  const kitOnCodex = kitEv.thread.provider === "codex" && kitEv.thread.account === added.data.id
    || kitEv.events.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.to === "codex" && e.payload.account === added.data.id);
  assert.equal(kitOnCodex, true, JSON.stringify({ provider: kitEv.thread.provider, account: kitEv.thread.account }));
  assert.equal(deltas(carol.frames, "assistant:juno", "QUINCE-7").length, 0, "the agent that was not mentioned did not answer");

  await until(async () => {
    const ev = (await b.reg.call("threads.get", { thread: kit.thread, limit: 200 }, "cli")).data.events;
    const rec = (await b.reg.call("threads.get", { thread: kit.thread }, "cli")).data.thread;
    return ev.some((/** @type {any} */ e) => e.type === "thread.finished") && (!ev.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.reason === "once") || ev.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.reason === "back") || rec.provider === "codex");
  }, "kit's turn to settle", 40_000);

  const askJuno = await b.as("bob")("stream.send", { chat: chat.id, text: "@juno the word is MAPLE-3", cwd: w.work });
  assert.equal(askJuno.error, undefined, askJuno.error && `${askJuno.error.code} ${askJuno.error.message}`);
  assert.deepEqual(askJuno.data.routed, ["assistant:juno"]);
  await until(() => deltas(carol.frames, "assistant:juno", "MAPLE-3").length > 0, "juno's answer", 120_000);
  const junoFrames = deltas(carol.frames, "assistant:juno", "MAPLE-3");
  assert.ok(junoFrames.every((f) => f.data.provider === "claude"), JSON.stringify(junoFrames.map((f) => f.data.provider)));
  const juno = b.stream().groups.member(chat.id, "assistant:juno");
  assert.ok(juno && juno.thread);
  const junoEv = (await b.reg.call("threads.get", { thread: juno.thread, limit: 300 }, "cli")).data;
  assert.ok(!junoEv.events.some((/** @type {any} */ e) => e.payload && e.payload.account === added.data.id), "the owner's turn did not use the other person's account");
  assert.equal(deltas(carol.frames, "assistant:kit", "MAPLE-3").length, 0);
  await b.stop();
});
