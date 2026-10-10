// @ts-check
// The runner module on a lender's computer, against a real home: its heartbeat reaches the home, a hand-over the person asked for is done at the next beat, a home it cannot reach freezes its sessions instead of
// letting them run ahead, a session the home took is ended when the home is reached again, and the Mac's sleep notice hands everything over. Real sandbox, real workspace, a fake agent, the in-memory Wink.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { createMemoryTransport } from "../../kernel/remote/memory-transport.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable } from "./workspace.js";
import mod, { seams } from "./index.js";
import { rig, SPACE, BOB } from "./testing/lent-rig.js";

const SKIP = unavailable() || workspaceUnavailable() || "";
const LINUX = process.platform === "linux";
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (/** @type {() => any} */ fn, ms = 20_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error("timed out"); };
/** The scheduler state ("T" stopped, "S" and "R" running) of every process on this box whose command line mentions `needle`: the fake agent of one world. */
const statesOf = (/** @type {string} */ needle) => {
  const out = [];
  for (const pid of fs.readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
    try { if (!fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle)) continue; const t = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); out.push(t.slice(t.lastIndexOf(")") + 2, t.lastIndexOf(")") + 3)); } catch { /* gone */ }
  }
  return out;
};

/** The runner module as a Mac runs it, reaching a home through a call we can cut. */
async function world(/** @type {import("node:test").TestContext} */ t, over = {}) {
  const agentDir = fs.mkdtempSync(path.join(SCRATCH, "bl-agent-"));
  fs.copyFileSync(new URL("./testing/fake-agent.js", import.meta.url), path.join(agentDir, "agent.js"));
  const root = fs.mkdtempSync(path.join(SCRATCH, "bl-root-"));
  const r = await rig(t, { keyIsDevice: true, lapseMs: 1500, specFor: async () => ({ command: process.execPath, args: [path.join(agentDir, "agent.js")], env: {}, routes: [], readOnly: [agentDir, path.dirname(process.execPath)], labels: {}, network: "provider", credentialRoutes: [] }), ...over });
  const chat = (await r.g.chats.create(r.bob, { people: [] })).id;
  const net = { cut: false };
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  const call = (/** @type {string} */ name, /** @type {any[]} */ args) => (net.cut ? Promise.reject(Object.assign(new Error("the network is down"), { code: "unavailable" })) : remote.call(name, args));
  /** @type {Map<string, any>} */ const tools = new Map();
  const handlers = new Map();
  const ctx = {
    paths: { root }, config: { role: "local", name: "Office Mac" },
    events: { emit: (/** @type {string} */ type) => { for (const f of handlers.get(type) || []) f({ type }); }, on: (/** @type {string} */ type, /** @type {any} */ f) => { handlers.set(type, [...(handlers.get(type) || []), f]); return () => handlers.set(type, (handlers.get(type) || []).filter((/** @type {any} */ x) => x !== f)); } },
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d),
    call: async (/** @type {string} */ name, /** @type {any} */ input) => (name === "settings.get" ? { data: { value: { "runner.enabled": true, "runner.plugged_in_only": false, "runner.cpu_percent": 90, "runner.memory_mb": 8192 }[input.key] } } : { data: { devices: [] } }),
    kernel: { owner: BOB, chain: async () => ({ hops: [{ actor: { kind: "person", id: BOB } }] }), for: () => ({ call }), runnerHost: () => ({ identity: async () => ({ deviceId: "eid_mac", deviceKey: "dev_laptop" }) }) },
  };
  // the machine's own load is not what is being tested (a busy test box would never be "well")
  seams.set(root, { heartbeatMs: 200, state: () => ({ onPower: true, awake: true, cpuPct: 5, memPct: 5 }) });
  const h = await mod.start(ctx);
  t.after(async () => { seams.delete(root); await h.stop(); fs.rmSync(agentDir, { recursive: true, force: true }); });
  const person = { caller: "cli" };
  const run = (/** @type {string} */ tool, /** @type {any} */ input) => tools.get(tool).run(input, person);
  return { r, chat, net, ctx, run, agent: path.join(agentDir, "agent.js"), emit: (/** @type {string} */ type) => ctx.events.emit(type, {}), handlers, book: r.home.book };
}

test("a session started on this computer is beaten for, and a hand-over the person asked for in the chat is done at the next beat", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const w = await world(t);
  const started = await w.run("runner.start", { space: SPACE, session: "s1", chat: w.chat });
  assert.equal(started.session, "s1");
  assert.deepEqual([w.book.get("s1").where, w.book.get("s1").epoch], ["mac", 1]);
  const first = w.book.get("s1").beat;
  await waitFor(() => w.book.get("s1").beat > first && w.book.get("s1").facts, 10_000);
  assert.ok(Number.isFinite(w.book.get("s1").facts.memoryMb), "the beat carries what the session uses");
  w.book.askRelease("s1", "you");
  await waitFor(() => w.book.get("s1").where === "server", 15_000);
  assert.deepEqual([w.book.get("s1").reason, w.book.get("s1").epoch], ["you", 2]);
  await waitFor(async () => (await w.run("runner.here", {})).sessions.length === 0, 10_000);   // gone from this computer once the hand-over has ended it
});

test("a home that cannot be reached freezes the sessions after two missed beats; a short outage thaws them and they are still this computer's", { skip: SKIP || !LINUX || false, timeout: 120_000 }, async t => {
  const w = await world(t, { lapseMs: 30_000 });
  await w.run("runner.start", { space: SPACE, session: "s1", chat: w.chat });
  await waitFor(() => statesOf(w.agent).length > 0 && statesOf(w.agent).every(x => x !== "T"), 10_000);
  w.net.cut = true;
  await sleep(1500); console.log("DEBUG states", JSON.stringify(statesOf(w.agent)));
  await waitFor(() => statesOf(w.agent).length > 0 && statesOf(w.agent).every(x => x === "T"), 10_000);
  assert.equal(w.book.get("s1").where, "mac", "the home has not taken it yet");
  w.net.cut = false;
  await waitFor(() => statesOf(w.agent).every(x => x !== "T"), 10_000);
  assert.equal(w.book.get("s1").where, "mac");
  assert.equal(w.book.get("s1").epoch, 1, "nothing moved");
});

test("a home that cannot be reached for a lapse takes the sessions; reached again, the computer ends what the home took and writes nothing", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const w = await world(t);   // lapse 1.5 s
  await w.run("runner.start", { space: SPACE, session: "s1", chat: w.chat });
  w.net.cut = true;
  await waitFor(() => w.book.lapsed().length === 1, 15_000);
  await w.r.home.sweep();
  assert.deepEqual([w.book.get("s1").where, w.book.get("s1").reason, w.book.get("s1").epoch], ["server", "offline", 2]);
  assert.deepEqual((await w.run("runner.here", {})).sessions.map((/** @type {any} */ x) => x.thread), [w.chat], "this computer still holds it, frozen, not knowing");
  w.net.cut = false;
  await waitFor(async () => (await w.run("runner.here", {})).sessions.length === 0, 15_000);
  if (LINUX) await waitFor(() => statesOf(w.agent).length === 0, 10_000);
});

test("the Mac's sleep notice hands every session over before the lid shuts, and waking checks in at once", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const w = await world(t);
  await w.run("runner.start", { space: SPACE, session: "s1", chat: w.chat });
  await w.run("runner.start", { space: SPACE, session: "s2" });
  w.emit("link.sleeping");
  await waitFor(() => w.book.get("s1").where === "server" && w.book.get("s2").where === "server", 20_000);
  assert.deepEqual([w.book.get("s1").reason, w.book.get("s2").reason], ["asleep", "asleep"], "a Mac without a lid reading says plain sleep");
  w.emit("link.woke");
  await sleep(600);
  assert.deepEqual(w.book.offered("dev_laptop").sort(), ["s1", "s2"], "awake and well: the sessions are offered back, not moved back");
});

test("switching running here off in Settings hands the sessions over with its reason", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const w = await world(t);
  await w.run("runner.start", { space: SPACE, session: "s1", chat: w.chat });
  const flip = w.ctx.call;
  w.ctx.call = async (/** @type {string} */ name, /** @type {any} */ input) => (name === "settings.get" && input.key === "runner.enabled" ? { data: { value: false } } : flip(name, input));
  await waitFor(() => w.book.get("s1").where === "server", 20_000);
  assert.equal(w.book.get("s1").reason, "switched-off");
});
