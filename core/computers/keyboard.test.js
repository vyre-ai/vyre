// @ts-check
// Take-over on its own: a stub switchboard whose lease emits lease.changed synchronously, the
// way the real one does inside threads.lease, and a clock the test moves past the 90 s TTL.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Pool, MIGRATIONS } from "./pool.js";
import { Keyboard, TTL } from "./keyboard.js";
import { FakeDriver } from "./driver/fake.js";
import { tempHome } from "../../test/helpers.js";

const AGENTS = [{ name: "kit", kind: "agent", computer: true }, { name: "juno", kind: "assistant", computer: true }];

function setup(t, { threads = { kit: ["th-kit-2", "th-kit-1"] }, switchboard = true } = {}) {
  const root = tempHome(t);
  const db = open(path.join(root, "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const clock = { t: 1_000 };
  /** @type {Array<{ type: string, payload: any, where?: any }>} */
  const events = [];
  /** @type {Set<(e: any) => void>} */
  const listeners = new Set();
  const leases = new Map();
  const leaseCalls = [];
  const bus = (thread, holder, previous) => { for (const fn of listeners) fn({ type: "lease.changed", thread, payload: { holder, previous } }); };
  const call = async (tool, input) => {
    if (tool === "agents.list") return { data: AGENTS };
    if (tool === "agents.threads") return { data: (threads[input.agent] || []).map(id => ({ id })) };
    if (switchboard && tool === "threads.lease") {
      leaseCalls.push(["lease", input.thread, input.surface]);
      const previous = leases.get(input.thread) || null;
      leases.set(input.thread, input.surface);
      if (previous !== input.surface) bus(input.thread, input.surface, previous);
      return { data: { thread: input.thread, holder: input.surface, previous } };
    }
    if (switchboard && tool === "threads.release") {
      leaseCalls.push(["release", input.thread, input.surface]);
      if (leases.get(input.thread) !== input.surface) return { data: { thread: input.thread, released: false, holder: leases.get(input.thread) || null } };
      leases.delete(input.thread);
      bus(input.thread, null, input.surface);
      return { data: { thread: input.thread, released: true, holder: null } };
    }
    return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
  };
  const emit = (type, payload, where) => { events.push({ type, payload, where }); };
  const pool = new Pool({ db, driver: new FakeDriver(), call, emit, now: () => clock.t });
  const kb = new Keyboard({ pool, call, emit, on: (_p, fn) => { listeners.add(fn); return () => listeners.delete(fn); } });
  /** Someone types into the thread from a surface: the lease moves, as threads.send would move it. */
  const chat = (thread, surface) => { const prev = leases.get(thread) || null; leases.set(thread, surface); bus(thread, surface, prev); };
  const changes = [];
  kb.on("changed", c => changes.push(c));
  return { pool, kb, clock, events, leases, leaseCalls, chat, changes, types: () => events.map(e => e.type) };
}

test("keyboard: take-over stops the agent's hands, names the holder, and giveback restores them", async t => {
  const { kb, pool, events, leases, leaseCalls, changes } = setup(t);
  assert.deepEqual(kb.mayAct("kit", "chrome.click"), { ok: true });
  const r = await kb.takeover("kit", "glass:laptop");
  assert.deepEqual(r, { agent: "kit", surface: "glass:laptop", thread: "th-kit-2", previous: null });
  assert.equal(leases.get("th-kit-2"), "glass:laptop", "the thread's lease did not move with the screen");
  assert.equal(pool.view("kit").screen, 1, "a take-over should hold a checkout");
  const no = kb.mayAct("kit", "chrome.click");
  assert.equal(no.ok, false);
  assert.equal(no.holder, "glass:laptop");
  assert.match(String(no.why), /glass:laptop has the keyboard of kit's computer/);
  assert.equal(kb.canType("kit", "glass:laptop"), true);
  assert.equal(kb.canType("kit", "glass:phone"), false);
  assert.deepEqual(events.find(e => e.type === "computer.taken-over"), { type: "computer.taken-over", payload: { agent: "kit", surface: "glass:laptop", thread: "th-kit-2" }, where: { thread: "th-kit-2" } });
  assert.deepEqual(await kb.giveback("kit", "glass:phone"), { agent: "kit", handed_back: false }, "a surface without the keyboard gave it back");
  assert.deepEqual(await kb.giveback("kit", "glass:laptop"), { agent: "kit", handed_back: true });
  assert.deepEqual(kb.mayAct("kit", "chrome.click"), { ok: true });
  assert.equal(kb.canType("kit", "glass:laptop"), false);
  assert.equal(leases.has("th-kit-2"), false);
  assert.deepEqual(leaseCalls, [["lease", "th-kit-2", "glass:laptop"], ["release", "th-kit-2", "glass:laptop"]]);
  assert.deepEqual(events.filter(e => e.type === "computer.handed-back").map(e => e.payload), [{ agent: "kit", surface: "glass:laptop", why: "gave back" }]);
  assert.deepEqual(changes, [{ agent: "kit", surface: "glass:laptop" }, { agent: "kit", surface: null }]);
});

test("keyboard: giveback is bound to whoever took over, when vyred verified who that was", async t => {
  const { kb } = setup(t);
  await kb.takeover("kit", "glass:laptop", "deck:someones-ipad");
  // The same surface, from a different verified caller (someone else's presence, or none at
  // all), cannot end it - only the caller who took it over, or a module, can.
  assert.deepEqual(await kb.giveback("kit", "glass:laptop", "deck:someone-elses-ipad"), { agent: "kit", handed_back: false });
  assert.deepEqual(await kb.giveback("kit", "glass:laptop"), { agent: "kit", handed_back: false });
  assert.deepEqual(await kb.giveback("kit", "glass:laptop", "module:glass"), { agent: "kit", handed_back: true }, "a module acting behind its own presence check still can");
});

test("keyboard: a take-over the lease moved has no verified caller to bind giveback to", async t => {
  const { kb, leases } = setup(t);
  await kb.takeover("kit", "glass:laptop", "deck:someones-ipad");
  leases.set("th-kit-2", "phone:pocket");
  kb.onLease({ thread: "th-kit-2", payload: { holder: "phone:pocket", previous: "glass:laptop" } });
  // Nobody vyred can verify made this happen (the lease moved it, not a direct takeover call),
  // so it falls back to the surface-only check that predates presence.
  assert.deepEqual(await kb.giveback("kit", "phone:pocket"), { agent: "kit", handed_back: true });
});

test("keyboard: the checkout's thread wins over the agent's latest", async t => {
  const { kb, pool } = setup(t);
  await pool.checkout("kit", { thread: "th-kit-1" });
  assert.equal((await kb.takeover("kit", "deck:laptop")).thread, "th-kit-1");
});

test("keyboard: a take-over nobody renews ends when the lease expires", async t => {
  const { kb, clock, events } = setup(t);
  await kb.takeover("kit", "glass:laptop");
  clock.t += TTL - 30_000;
  const renew = await kb.takeover("kit", "glass:laptop");
  assert.equal(renew.previous, "glass:laptop");
  assert.equal(events.filter(e => e.type === "computer.taken-over").length, 1, "a renewal was reported as a new take-over");
  clock.t += TTL - 1;
  assert.equal(kb.mayAct("kit").ok, false, "a renewed take-over expired early");
  clock.t += 1;
  kb.sweep();
  assert.deepEqual(kb.mayAct("kit"), { ok: true });
  assert.deepEqual(events.at(-1)?.payload, { agent: "kit", surface: "glass:laptop", why: "lease expired" });
});

test("keyboard: chatting with the agent moves the lease but never pauses its hands", async t => {
  const { kb, chat, types } = setup(t);
  chat("th-kit-2", "deck:laptop");
  chat("th-kit-2", "phone:pocket");
  assert.deepEqual(kb.mayAct("kit", "chrome.type"), { ok: true });
  assert.equal(kb.canType("kit", "deck:laptop"), false);
  assert.deepEqual(types(), []);
});

test("keyboard: the lease moving to another person's screen moves the take-over there", async t => {
  const { kb, chat, events } = setup(t);
  await kb.takeover("kit", "glass:laptop");
  chat("th-kit-2", "phone:pocket");
  assert.equal(kb.canType("kit", "phone:pocket"), true);
  assert.equal(kb.canType("kit", "glass:laptop"), false);
  assert.equal(kb.mayAct("kit").holder, "phone:pocket");
  assert.deepEqual(events.at(-1)?.payload, { agent: "kit", surface: "phone:pocket", thread: "th-kit-2" });
});

test("keyboard: the lease released or moved to something that is not a screen ends the take-over", async t => {
  const a = setup(t);
  await a.kb.takeover("kit", "glass:laptop");
  a.chat("th-kit-2", "mcp:agent:juno");
  assert.deepEqual(a.kb.mayAct("kit"), { ok: true });
  assert.equal(a.events.at(-1)?.payload.why, "lease released");
  await a.kb.takeover("kit", "glass:laptop");
  a.leases.delete("th-kit-2");
  a.kb.onLease({ thread: "th-kit-2", payload: { holder: null, previous: "glass:laptop" } });
  assert.deepEqual(a.kb.mayAct("kit"), { ok: true });
  assert.deepEqual(a.events.at(-1)?.payload, { agent: "kit", surface: "glass:laptop", why: "lease released" });
});

test("keyboard: another person's screen taking over replaces the first", async t => {
  const { kb } = setup(t);
  await kb.takeover("kit", "glass:laptop");
  const r = await kb.takeover("kit", "glass:tablet");
  assert.equal(r.previous, "glass:laptop");
  assert.equal(kb.canType("kit", "glass:tablet"), true);
  assert.equal(kb.canType("kit", "glass:laptop"), false);
});

test("keyboard: with no thread, the record alone decides", async t => {
  const { kb, leaseCalls, clock } = setup(t, { threads: {} });
  const r = await kb.takeover("kit", "glass:laptop");
  assert.equal(r.thread, null);
  assert.equal(kb.mayAct("kit").ok, false);
  assert.deepEqual(leaseCalls, []);
  assert.deepEqual(await kb.giveback("kit", "glass:laptop"), { agent: "kit", handed_back: true });
  await kb.takeover("kit", "glass:laptop");
  clock.t += TTL;
  assert.equal(kb.mayAct("kit").ok, true, "an unrenewed record should lapse like a lease");
});

test("keyboard: without a switchboard the take-over still works on the record", async t => {
  const { kb } = setup(t, { switchboard: false });
  const r = await kb.takeover("kit", "glass:laptop");
  assert.equal(r.thread, null);
  assert.equal(kb.mayAct("kit").ok, false);
});

test("keyboard: a paused agent's hands are refused; its surface must be a person's screen", async t => {
  const { kb, pool } = setup(t);
  pool.pause("kit", true);
  assert.match(String(kb.mayAct("kit", "desktop.press").why), /kit is paused/);
  pool.pause("kit", false);
  assert.equal(kb.mayAct("kit").ok, true);
  await assert.rejects(kb.takeover("kit", "cli"), /not a person's screen/);
});

test("keyboard: a take-over holds the screen through idle sweeps, and the idle clock restarts on giveback", async t => {
  const { kb, pool, clock } = setup(t);
  await kb.takeover("kit", "glass:laptop");
  clock.t += 80_000; await pool.sweep();
  assert.equal(pool.view("kit").screen, 1);
  assert.equal(pool.view("kit").takeover, "glass:laptop");
  await kb.giveback("kit", "glass:laptop");
  clock.t += 59_999; await pool.sweep();
  assert.equal(pool.view("kit").screen, 1);
  clock.t += 1; await pool.sweep();
  assert.equal(pool.view("kit").screen, null);
});
