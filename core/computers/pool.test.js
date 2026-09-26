// @ts-check
// The pool on its own: a fake driver, a stubbed agents module and a clock the test moves, so
// idle release, freezing and eviction are checked in milliseconds rather than minutes.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Pool, MIGRATIONS, TICKET_MS } from "./pool.js";
import { FakeDriver } from "./driver/fake.js";
import { tempHome } from "../../test/helpers.js";

const AGENTS = [
  { name: "juno", kind: "assistant", computer: true },
  { name: "kit", kind: "agent", computer: true },
  { name: "pax", kind: "agent", computer: true },
  { name: "rio", kind: "agent", computer: false },
];

/** A pool with everything it talks to faked, and the events it emitted. */
function setup(t, { config = {}, agents = AGENTS, driver = new FakeDriver() } = {}) {
  const root = tempHome(t);
  const db = open(path.join(root, "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const clock = { t: 1_000 };
  /** @type {Array<{ type: string, payload: any }>} */
  const events = [];
  const call = async tool => {
    if (tool === "agents.list" && agents) return { data: agents };
    return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
  };
  const pool = new Pool({ db, driver, call, emit: (type, payload) => { events.push({ type, payload }); }, config: { waitMs: 200, ...config }, now: () => clock.t });
  return { pool, driver, events, clock, db, types: () => events.map(e => e.type) };
}

test("pool: a computer is made on first need, not before", async t => {
  const { pool, driver, types } = setup(t);
  assert.equal(pool.view("kit").state, "none");
  assert.equal(driver.containers.size, 0);
  const r = await pool.checkout("kit", { thread: "th-1" });
  assert.deepEqual(r, { agent: "kit", screen: 1, thread: "th-1" });
  assert.deepEqual(driver.calls.map(c => c.op), ["create", "start"]);
  const spec = [...driver.containers.values()][0].spec;
  assert.deepEqual(Object.keys(spec.env).sort(), ["COMPUTERD_TOKEN", "SCREEN", "VNC_PASSWORD"]);
  assert.equal(spec.env.SCREEN, "1440x900");
  assert.equal(spec.env.VNC_PASSWORD.length, 8);
  assert.deepEqual(spec.labels, { "vyre.computer": "kit", "vyre.managed": "true" });
  assert.equal(spec.volume, "vyre-home-kit");
  assert.deepEqual(types(), ["computer.created", "computer.checked-out"]);
  // Checking out again only touches it.
  assert.deepEqual(await pool.checkout("kit"), { agent: "kit", screen: 1, thread: "th-1" });
  assert.equal(driver.calls.length, 2);
  assert.equal(pool.view("kit").state, "running");
});

test("pool: only agents whose record says computer: true get one, and only with the agents module", async t => {
  const { pool } = setup(t);
  await assert.rejects(pool.checkout("rio"), /rio has no computer; set computer: true/);
  await assert.rejects(pool.checkout("nobody"), /no agent nobody/);
  const none = setup(t, { agents: null });
  await assert.rejects(none.pool.checkout("kit"), /agents module is not running/);
  const off = new Pool({ db: pool.db, driver: null, call: async () => ({}), emit: () => {} });
  await assert.rejects(off.checkout("kit"), /no computer driver is configured/);
});

test("pool: idle checkouts are released, then frozen, and a checkout thaws them", async t => {
  const { pool, driver, clock, events } = setup(t);
  await pool.checkout("kit");
  clock.t += 59_999; await pool.sweep();
  assert.equal(pool.view("kit").screen, 1, "released before idleMs");
  clock.t += 1; await pool.sweep();
  assert.equal(pool.view("kit").screen, null);
  assert.deepEqual(events.at(-1), { type: "computer.released", payload: { agent: "kit", why: "idle" } });
  assert.equal(pool.view("kit").state, "running", "a released computer stays warm for freezeMs");
  clock.t += 14_999; await pool.sweep();
  assert.equal(pool.view("kit").state, "running");
  clock.t += 1; await pool.sweep();
  assert.equal(pool.view("kit").state, "frozen");
  assert.equal(driver.calls.at(-1)?.op, "pause");
  await pool.checkout("kit");
  assert.equal(pool.view("kit").state, "running");
  assert.equal(driver.calls.at(-1)?.op, "unpause");
  assert.ok(events.some(e => e.type === "computer.thawed"));
  assert.equal(driver.containers.size, 1, "a thaw made a new container");
});

test("pool: touching keeps a checkout; a viewer holds it outright", async t => {
  const { pool, clock } = setup(t);
  await pool.checkout("kit");
  clock.t += 50_000; pool.touch("kit");
  clock.t += 50_000; await pool.sweep();
  assert.equal(pool.view("kit").screen, 1);
  assert.equal(await pool.viewer("kit", 1), 1);
  clock.t += 600_000; await pool.sweep();
  assert.equal(pool.view("kit").screen, 1, "a watched screen was released");
  assert.equal(pool.view("kit").viewers, 1);
  await pool.viewer("kit", -1);
  clock.t += 59_999; await pool.sweep();
  assert.equal(pool.view("kit").screen, 1, "the idle clock should start when the last viewer left");
  clock.t += 1; await pool.sweep();
  assert.equal(pool.view("kit").screen, null);
});

test("pool: a checkout notices its container vanished, and the next one rebuilds it", async t => {
  const { pool, driver, clock, types } = setup(t, { config: { verifyMs: 1_000 } });
  await pool.checkout("kit");
  const id = [...driver.containers.keys()][0];
  // Well within verifyMs: touching alone never asks the driver anything.
  clock.t += 500; await pool.checkout("kit");
  assert.deepEqual(driver.calls.map(c => c.op), ["create", "start"]);
  await driver.remove(id); // an operator, or the box, removes it out from under vyred
  clock.t += 1_000;
  const r = await pool.checkout("kit"); // past verifyMs: this call notices and rebuilds
  assert.equal(pool.view("kit").state, "running");
  assert.notEqual([...driver.containers.keys()].find(k => k !== id), undefined, "a fresh container exists");
  assert.deepEqual(types(), ["computer.created", "computer.checked-out", "computer.released", "computer.created", "computer.checked-out"]);
  assert.equal(r.screen, 1);
});

test("pool: a driver error while verifying is not treated as the container being gone", async t => {
  const driver = new FakeDriver();
  const { pool, clock } = setup(t, { driver, config: { verifyMs: 1_000 } });
  await pool.checkout("kit");
  const real = driver.inspect.bind(driver);
  driver.inspect = async id => { throw new Error("proxy timed out"); };
  clock.t += 1_000;
  await pool.checkout("kit"); // verify() swallows the error; a held checkout is still held
  assert.equal(pool.view("kit").screen, 1);
  driver.inspect = real;
});

test("pool: a first viewer checks out and thaws", async t => {
  const { pool, clock } = setup(t);
  await pool.checkout("kit");
  pool.release("kit");
  clock.t += 15_000; await pool.sweep();
  assert.equal(pool.view("kit").state, "frozen");
  await pool.viewer("kit", 1);
  assert.equal(pool.view("kit").state, "running");
  assert.equal(pool.view("kit").viewers, 1);
});

test("pool: a full pool evicts the least recently touched unwatched checkout", async t => {
  const { pool, clock, events } = setup(t);
  await pool.checkout("kit");
  clock.t += 10; await pool.checkout("pax");
  clock.t += 10; pool.touch("kit");
  clock.t += 10;
  const r = await pool.checkout("juno");
  assert.equal(r.screen, 2, "juno should get pax's screen");
  assert.equal(pool.view("pax").screen, null);
  assert.ok(events.some(e => e.type === "computer.released" && e.payload.agent === "pax" && e.payload.why === "evicted"));
});

test("pool: when every screen is watched or taken over, a checkout waits, then names who holds them", async t => {
  const { pool } = setup(t, { config: { screens: 1, waitMs: 80 } });
  await pool.viewer("kit", 1);
  const t0 = Date.now();
  await assert.rejects(pool.checkout("pax"), /every screen is in use \(kit \(watched by 1\)\)/);
  assert.ok(Date.now() - t0 >= 70, "it did not wait");
  pool.heldBy = a => (a === "kit" ? "glass:laptop" : null);
  await assert.rejects(pool.checkout("pax"), /kit \(taken over by glass:laptop\)/);
});

test("pool: a waiting checkout gets the screen as soon as one is released", async t => {
  const { pool } = setup(t, { config: { screens: 1, waitMs: 5_000 } });
  await pool.viewer("kit", 1);
  const waiting = pool.checkout("pax");
  await new Promise(r => setTimeout(r, 20));
  pool.release("kit");
  assert.equal((await waiting).screen, 1);
});

test("pool: two agents checking out at once never share a screen", async t => {
  const { pool } = setup(t, { config: { screens: 2 } });
  const got = await Promise.all([pool.checkout("kit"), pool.checkout("pax")]);
  assert.deepEqual(got.map(g => g.screen).sort(), [1, 2]);
});

test("pool: stop keeps the home, the next checkout starts the same container", async t => {
  const { pool, driver } = setup(t);
  await pool.checkout("kit");
  assert.deepEqual(await pool.stop("kit"), { stopped: true });
  assert.equal(pool.view("kit").state, "stopped");
  assert.equal(pool.view("kit").screen, null);
  assert.ok(!driver.calls.some(c => c.op === "remove"));
  await pool.checkout("kit");
  assert.equal(driver.calls.filter(c => c.op === "create").length, 1);
  assert.equal(pool.view("kit").state, "running");
});

test("pool: stopping a frozen computer thaws it first", async t => {
  const { pool, driver, clock } = setup(t);
  await pool.checkout("kit");
  pool.release("kit");
  clock.t += 15_000; await pool.sweep();
  await pool.stop("kit");
  assert.deepEqual(driver.calls.slice(-2).map(c => c.op), ["unpause", "stop"]);
});

test("pool: a container removed behind vyred's back is made again", async t => {
  const { pool, driver } = setup(t);
  await pool.checkout("kit");
  const first = pool.row("kit");
  pool.release("kit");
  await driver.remove(String(first.container));
  await pool.checkout("kit");
  const second = pool.row("kit");
  assert.notEqual(second.container, first.container);
  assert.notEqual(second.helper_token, first.helper_token, "a new container kept the old token");
});

test("pool: a Glass ticket works once and expires after 30 s", async t => {
  const { pool, clock } = setup(t);
  const a = pool.ticket("kit", "glass:laptop");
  assert.ok(a.length >= 32);
  assert.deepEqual(pool.redeem(a), { agent: "kit", surface: "glass:laptop" });
  assert.equal(pool.redeem(a), null, "a ticket worked twice");
  const b = pool.ticket("kit", "glass:laptop");
  clock.t += TICKET_MS;
  assert.equal(pool.redeem(b), null, "an expired ticket worked");
  assert.equal(pool.redeem("made-up"), null);
});

test("pool: vnc, endpoint and size come from memory and the table", async t => {
  const { pool } = setup(t);
  assert.equal(pool.vnc("kit"), null);
  await pool.checkout("kit");
  const r = pool.row("kit");
  assert.deepEqual(pool.vnc("kit"), { host: "fake-kit", port: 5900, password: r.vnc_password });
  assert.deepEqual(pool.endpoint("kit"), { helper: { url: "http://fake-kit:7000", token: r.helper_token } });
  assert.deepEqual(pool.size("kit"), { w: 1440, h: 900 });
});

test("pool: reconcile makes the table agree with the driver after a restart", async t => {
  const driver = new FakeDriver();
  const a = setup(t, { driver });
  await a.pool.checkout("kit");
  await a.pool.checkout("pax");
  a.pool.release("pax");
  a.clock.t += 15_000; await a.pool.sweep();
  const pax = String(a.pool.row("pax").container);
  // Behind vyred's back: kit's container vanishes, and an orphan appears with no row.
  await driver.remove(String(a.pool.row("kit").container));
  const orphan = (await driver.create({ agent: "juno", image: "i", env: {}, labels: {}, volume: "v" })).id;
  const b = new Pool({ db: a.db, driver, call: async () => ({ data: AGENTS }), emit: () => {}, now: () => a.clock.t });
  await b.reconcile();
  assert.equal(b.view("kit").state, "none");
  assert.equal(b.row("kit").container, null);
  assert.equal(b.view("pax").state, "frozen");
  assert.equal(b.row("pax").container, pax);
  assert.equal(driver.containers.has(orphan), false, "an orphan with lost passwords was kept");
  await b.checkout("pax");
  assert.equal(b.row("pax").container, pax, "a thaw after restart made a new container");
});

test("pool: a running computer nobody checked out after a restart freezes on schedule", async t => {
  const driver = new FakeDriver();
  const a = setup(t, { driver });
  await a.pool.checkout("kit");
  const b = new Pool({ db: a.db, driver, call: async () => ({ data: AGENTS }), emit: () => {}, now: () => a.clock.t });
  await b.reconcile();
  assert.equal(b.view("kit").state, "running");
  assert.equal(b.view("kit").screen, null);
  a.clock.t += 15_000; await b.sweep();
  assert.equal(b.view("kit").state, "frozen");
});

test("pool: pause and resume are recorded and emitted once each", async t => {
  const { pool, types } = setup(t);
  assert.deepEqual(pool.pause("kit", true), { paused: true });
  pool.pause("kit", true);
  assert.equal(pool.isPaused("kit"), true);
  pool.pause("kit", false);
  assert.deepEqual(types(), ["computer.paused", "computer.resumed"]);
});


test("pool: a computer that exits on boot fails the checkout with the reason, and is not left running", async t => {
  const { pool, driver } = setup(t);
  driver.crashing.add("kit");
  await assert.rejects(pool.checkout("kit"), /kit's computer stopped as soon as it started \(exit code 127\).*docker logs vyre-computer-kit/);
  assert.equal(pool.view("kit").state, "stopped");
  assert.equal(pool.view("kit").screen, null, "the screen went back to the pool");
  assert.equal(pool.vnc("kit"), null);
  driver.crashing.delete("kit");
  assert.equal((await pool.checkout("kit")).screen, 1, "a fixed image starts the same container");
  assert.equal(pool.view("kit").state, "running");
});

test("pool: a checkout waits for the screen to answer, and gives up after bootMs", async t => {
  let answers = 0;
  const { pool } = setup(t, { config: { bootMs: 5_000 } });
  pool.probe = async () => ++answers >= 3;
  await pool.checkout("kit");
  assert.equal(answers, 3, "probed until the screen answered");
  pool.probe = async () => false;
  pool.opts.bootMs = 100;
  await assert.rejects(pool.checkout("pax"), /pax's computer started but its screen did not answer within 0 s/);
});

test("pool: a computer that died while idle freezes to stopped, not a stuck running", async t => {
  const { pool, driver, clock, types } = setup(t, { config: { idleMs: 10, freezeMs: 10 } });
  await pool.checkout("kit");
  pool.release("kit");
  const c = [...driver.containers.values()][0];
  c.state = "exited";
  clock.t += 20;
  await pool.sweep();
  assert.equal(pool.view("kit").state, "stopped");
  assert.ok(types().includes("computer.stopped"));
  assert.equal((await pool.checkout("kit")).screen, 1, "the next checkout starts it");
  assert.equal(pool.view("kit").state, "running");
});

test("pool: limits apply at restart, which keeps the home and the checkout and changes the passwords", async t => {
  const { pool, driver } = setup(t);
  await pool.checkout("kit");
  const before = pool.vnc("kit");
  const first = [...driver.containers.values()][0];
  assert.deepEqual([first.spec.cpus, first.spec.memoryMb], [2, 3072]);
  assert.deepEqual([pool.view("kit").cpus, pool.view("kit").memory_gb], [2, 3]);
  assert.throws(() => pool.limits("kit", { cpus: 0 }), /cpus is a whole number of cores from 1 to 16/);
  assert.throws(() => pool.limits("kit", { memory_gb: 1.5 }), /memory_gb is a whole number/);
  assert.throws(() => pool.limits("kit", {}), /say cpus or memory_gb/);
  const v = pool.limits("kit", { cpus: 4, memory_gb: 8 });
  assert.deepEqual([v.cpus, v.memory_gb], [4, 8]);
  assert.equal(first.spec.cpus, 2, "the running container keeps its limits until a restart");
  const r = await pool.restart("kit");
  assert.equal(r.state, "running");
  assert.equal(r.screen, 1, "the checkout survives");
  assert.equal(driver.containers.has(first.id), false, "the old container is gone");
  const next = [...driver.containers.values()][0];
  assert.deepEqual([next.spec.cpus, next.spec.memoryMb, next.spec.volume], [4, 8192, first.spec.volume]);
  assert.notEqual(pool.vnc("kit").password, before.password);
  await assert.rejects(pool.restart("rio"), /rio has no computer/);
});

test("pool: restarting a computer nobody holds leaves it to freeze on schedule", async t => {
  const { pool, clock } = setup(t, { config: { freezeMs: 10 } });
  await pool.restart("kit");
  assert.equal(pool.view("kit").state, "running");
  assert.equal(pool.view("kit").screen, null);
  clock.t += 20;
  await pool.sweep();
  assert.equal(pool.view("kit").state, "frozen");
});
