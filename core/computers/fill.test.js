// @ts-check
// A Vault fill on its own: the real Pool, Shield and Keyboard on the fake driver, a recording
// computerd (`tell`), and a clock and timer queue the test moves.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Pool, MIGRATIONS } from "./pool.js";
import { Keyboard } from "./keyboard.js";
import { Shield, FILLING, SHIELDED } from "./shield.js";
import { Fills, LIMIT_MS } from "./fill.js";
import { FakeDriver } from "./driver/fake.js";
import { tempHome } from "../../test/helpers.js";

const AGENTS = [{ name: "kit", kind: "agent", computer: true }, { name: "pax", kind: "agent", computer: false }];

function setup(t, { answers = true } = {}) {
  const root = tempHome(t);
  const db = open(path.join(root, "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const clock = { t: 1_000 };
  /** @type {Array<{ type: string, payload: any }>} */
  const events = [];
  /** @type {Map<string, Set<(e: any) => void>>} */
  const listeners = new Map();
  const on = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)?.add(fn); return () => listeners.get(type)?.delete(fn); };
  const emit = (type, payload) => { events.push({ type, payload }); for (const fn of listeners.get(type) || []) fn({ type, payload }); };
  const call = async tool => tool === "agents.list" ? { data: AGENTS } : { error: { code: "no_such_tool", message: tool } };
  const pool = new Pool({ db, driver: new FakeDriver(), call, emit, now: () => clock.t });
  /** What computerd was told, in order. */
  const told = [];
  const shield = new Shield({ pool, emit, on, tell: async (agent, onOff, o) => { told.push({ agent, on: onOff, ...o }); return answers; } });
  const keyboard = new Keyboard({ pool, call, emit, on, idleMs: () => 0 });
  const timers = [];
  const schedule = (fn, ms) => { const tm = { at: clock.t + ms, fn, dead: false }; timers.push(tm); return () => { tm.dead = true; }; };
  const due = () => { for (const tm of timers) if (!tm.dead && tm.at <= clock.t) { tm.dead = true; tm.fn(); } };
  const helper = async agent => { await pool.allowed(agent); await pool.ensure(agent); return { url: "http://computer-kit:7000/", token: "helper-token" }; };
  const fills = new Fills({ pool, shield, keyboard, emit, on, helper, schedule });
  t.after(() => { fills.stop(); keyboard.stop(); shield.stop(); });
  return { pool, shield, keyboard, fills, clock, events, told, due, emit, types: () => events.map(e => e.type) };
}

test("fill: begin shields for the fill, cuts the agent's eyes, and hands out a token for this fill only", async t => {
  const { fills, shield, told, events } = setup(t);
  const r = await fills.begin("kit", "https://app.northwind.test");
  assert.equal(r.cdpUrl, "http://computer-kit:7000/cdp");
  assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.expires, 1_000 + LIMIT_MS);
  assert.notEqual(r.token, "helper-token");
  assert.deepEqual(told, [{ agent: "kit", on: true, reason: "fill", fill_token: r.token }]);
  assert.deepEqual(shield.mayAct("kit", true, () => ({ ok: true })), { ok: false, why: FILLING });
  assert.deepEqual(events.find(e => e.type === "computer.fill-began")?.payload, { agent: "kit", fill: r.fill, origin: "https://app.northwind.test" });
  assert.ok(!JSON.stringify(events).includes(r.token), "the token reached an event");
});

test("fill: end drops the token, lowers the shield and names the tab; twice is a no-op", async t => {
  const { fills, shield, told, events } = setup(t);
  const r = await fills.begin("kit", "https://app.northwind.test");
  assert.deepEqual(await fills.end("kit", "not-this-fill"), { agent: "kit", ended: false });
  assert.equal(shield.has("kit"), true);
  assert.deepEqual(await fills.end("kit", r.fill, { target: "T1A2B3" }), { agent: "kit", ended: true });
  assert.equal(shield.has("kit"), false);
  assert.deepEqual(told.at(-1), { agent: "kit", on: false, reason: "fill" });
  assert.deepEqual(events.find(e => e.type === "computer.fill-ended")?.payload, { agent: "kit", fill: r.fill, why: "done", target: "T1A2B3" });
  assert.deepEqual(await fills.end("kit", r.fill), { agent: "kit", ended: false });
});

test("fill: a fill left open ends itself after the limit", async t => {
  const { fills, shield, clock, due, events } = setup(t);
  const r = await fills.begin("kit", "https://app.northwind.test");
  clock.t += LIMIT_MS - 1; due();
  assert.equal(shield.has("kit"), true);
  clock.t += 1; due();
  await new Promise(res => setImmediate(res));
  assert.equal(shield.has("kit"), false);
  assert.deepEqual(events.find(e => e.type === "computer.fill-ended")?.payload, { agent: "kit", fill: r.fill, why: "expired" });
});

test("fill: a computer that stops ends its fill", async t => {
  const { fills, emit, events } = setup(t);
  const r = await fills.begin("kit", "https://app.northwind.test");
  emit("computer.stopped", { agent: "kit" });
  await new Promise(res => setImmediate(res));
  assert.equal(fills.has("kit"), false);
  assert.equal(events.find(e => e.type === "computer.fill-ended")?.payload.why, "stopped");
  assert.equal(r.fill.length > 0, true);
});

test("fill: refused while a person has the keyboard, signs in privately, or another fill is open", async t => {
  const { fills, keyboard, shield } = setup(t);
  await keyboard.takeover("kit", "glass:laptop");
  await assert.rejects(fills.begin("kit", "https://a.test"), e => e.code === "busy" && /glass:laptop has the keyboard/.test(e.message));
  await keyboard.giveback("kit", "glass:laptop");
  await shield.set("kit", true, { reason: "person" });
  await assert.rejects(fills.begin("kit", "https://a.test"), e => e.code === "busy" && /a person is signing in/.test(e.message));
  assert.equal(fills.has("kit"), false, "a refused fill stayed open");
  assert.deepEqual(shield.mayAct("kit", true, () => ({ ok: true })), { ok: false, why: SHIELDED }, "a refused fill changed the person's shield");
  await shield.set("kit", false, { reason: "person" });
  await fills.begin("kit", "https://a.test");
  await assert.rejects(fills.begin("kit", "https://a.test"), e => e.code === "busy" && /another sign-in/.test(e.message));
});

test("fill: a person's hand-back or shield never lowers a fill's shield, and a private sign-in waits for it", async t => {
  const { fills, shield, emit } = setup(t);
  await fills.begin("kit", "https://a.test");
  emit("computer.handed-back", { agent: "kit", surface: "glass:laptop", why: "gave back" });
  await new Promise(res => setImmediate(res));
  assert.equal(shield.reason("kit"), "fill");
  assert.deepEqual(await shield.set("kit", false, { reason: "person" }), { agent: "kit", shielded: true, computerd: false });
  await assert.rejects(shield.set("kit", true, { reason: "person" }), e => e.code === "busy" && /being filled/.test(e.message));
  assert.equal(shield.reason("kit"), "fill");
});

test("fill: a computerd that does not answer fails the fill and leaves no shield up", async t => {
  const { fills, shield, told } = setup(t, { answers: false });
  await assert.rejects(fills.begin("kit", "https://a.test"), /did not answer/);
  assert.equal(shield.has("kit"), false);
  assert.equal(fills.has("kit"), false);
  assert.deepEqual(told.map(x => x.on), [true, false]);
});

test("fill: an agent without a computer is no_computer", async t => {
  const { fills } = setup(t);
  await assert.rejects(fills.begin("pax", "https://a.test"), e => e.code === "no_computer");
});
