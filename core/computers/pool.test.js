// @ts-check
// The pool on its own: a fake driver, a stubbed agents module and a clock the test moves, so
// idle release, freezing and eviction are checked in milliseconds rather than minutes.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
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
function setup(t, { config = {}, agents = AGENTS, driver = new FakeDriver(), egress = undefined, memberTokenKey = undefined } = {}) {
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
  const pool = new Pool({ db, driver, call, emit: (type, payload) => { events.push({ type, payload }); }, config: { waitMs: 200, ...config }, now: () => clock.t,
    egress: () => egress && egress.cfg, memberTokenKey });
  return { pool, driver, events, clock, db, types: () => events.map(e => e.type) };
}

/**
 * A fake computerd, standing in for its own /agents/reload and /agents/dispose (the real thing is
 * checked live elsewhere; here the pool's own request shape and sequencing matter, not
 * computerd's). Returns { port, calls, close }; calls records what actually arrived.
 * @param {{ bearer: () => string, dispose?: boolean }} o
 */
async function fakeComputerd({ bearer, reload = { agents: 1, revoked: [] }, dispose = { disposed: true } }) {
  /** @type {Array<{ method: string, path: string, authorization: string, body: any }>} */
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    calls.push({ method: req.method, path: req.url, authorization: String(req.headers.authorization || ""), body });
    if (req.headers.authorization !== `Bearer ${bearer()}`) { res.writeHead(401).end(); return; }
    if (req.method === "POST" && req.url === "/agents/reload") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reload)); return; }
    if (req.method === "POST" && req.url === "/agents/dispose") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(dispose)); return; }
    res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = /** @type {any} */ (server.address()).port;
  return { port, calls, close: () => new Promise(r => server.close(r)) };
}

test("pool: a computer is made on first need, not before", async t => {
  const { pool, driver, types } = setup(t);
  assert.equal(pool.view("kit").state, "none");
  assert.equal(driver.containers.size, 0);
  const r = await pool.checkout("kit", { thread: "th-1" });
  assert.deepEqual(r, { agent: "kit", screen: 1, thread: "th-1" });
  assert.deepEqual(driver.calls.map(c => c.op), ["create", "seed", "start"]);
  const spec = [...driver.containers.values()][0].spec;
  // No secret in Env (every docker exec inherits it); seed() hands them over as a file instead.
  assert.deepEqual(Object.keys(spec.env).sort(), ["SCREEN"]);
  assert.equal(spec.env.SCREEN, "1440x900");
  const boot = [...driver.containers.values()][0].boot;
  assert.equal(boot.vnc_password.length, 8);
  assert.equal(boot.vnc_password, pool.row("kit").vnc_password);
  assert.equal(boot.computerd_token, pool.row("kit").helper_token);
  assert.deepEqual(spec.labels, { "vyre.computer": "kit", "vyre.managed": "true" });
  assert.equal(spec.volume, "vyre-home-kit");
  assert.deepEqual(types(), ["computer.created", "computer.checked-out"]);
  // Checking out again only touches it.
  assert.deepEqual(await pool.checkout("kit"), { agent: "kit", screen: 1, thread: "th-1" });
  assert.equal(driver.calls.length, 3);
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
  assert.deepEqual(driver.calls.map(c => c.op), ["create", "seed", "start"]);
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
  await assert.rejects(pool.checkout("pax"), /kit \(taken over by you\)/);
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
  assert.deepEqual(pool.redeem(a), { agent: "kit", surface: "glass:laptop", slow: false });
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

test("pool: the egress PAC reaches a new computer's env only when on with sites, and a change remakes a stopped one", async t => {
  const egress = { cfg: /** @type {any} */ (undefined) };
  const { pool, driver } = setup(t, { egress });
  await pool.checkout("kit", { thread: "th-1" });
  const first = [...driver.containers.values()][0];
  assert.equal(first.spec.env.VYRE_PROXY_PAC, undefined, "off by default");
  // A running computer keeps what it was made with.
  egress.cfg = { enabled: true, sites: ["bank.example.com"] };
  pool.release("kit", "released");
  await pool.checkout("kit", { thread: "th-1" });
  assert.equal(driver.containers.size, 1);
  assert.equal([...driver.containers.values()][0].id, first.id);
  // Stopped, it is made again with the new setting; its home volume is the same one.
  await pool.stop("kit");
  await pool.checkout("kit", { thread: "th-1" });
  const second = [...driver.containers.values()];
  assert.equal(second.length, 1);
  assert.notEqual(second[0].id, first.id);
  assert.match(second[0].spec.env.VYRE_PROXY_PAC, /^data:application\/x-ns-proxy-autoconfig;base64,/);
  assert.equal(second[0].spec.volume, first.spec.volume);
  // Stopped again with the setting unchanged: started, not remade.
  await pool.stop("kit");
  await pool.checkout("kit", { thread: "th-1" });
  assert.equal([...driver.containers.values()][0].id, second[0].id);
  // Turned off: the next start drops it again.
  egress.cfg = { enabled: false, sites: ["bank.example.com"] };
  await pool.stop("kit");
  await pool.checkout("kit", { thread: "th-1" });
  assert.equal([...driver.containers.values()][0].spec.env.VYRE_PROXY_PAC, undefined);
});

test("pool: a bad egress site list stops a new computer instead of making one that goes DIRECT", async t => {
  const { pool, driver } = setup(t, { egress: { cfg: { enabled: true, sites: ["bank example.com"] } } });
  await assert.rejects(pool.checkout("kit", { thread: "th-1" }), /is not a hostname/);
  assert.equal(driver.containers.size, 0);
});

test("pool: a boot failure says so, with a short reason fit for Glass", async t => {
  const { pool, driver } = setup(t);
  driver.crashing.add("kit");
  const e = await pool.checkout("kit").catch(x => x);
  assert.equal(e.boot, true);
  assert.equal(e.short, "kit's computer stopped as soon as it started (exit code 127)");
  assert.ok(Buffer.byteLength(e.short) <= 123);
});

// ---- shared (browser-kind) computers ----------------------------------------------------

test("pool: addAgent makes a fresh shared computer, seeds it before start (not after), and reloads it once running", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  const key = () => Promise.resolve("test-vault-key");
  ({ pool } = setup(t, { driver, memberTokenKey: key }));

  const r = await pool.addAgent("browser-abc123", "kit-1", "alice");
  assert.equal(r.computer, "browser-abc123");
  assert.equal(pool.row("browser-abc123").kind, "browser");
  assert.deepEqual(driver.calls.map(c => c.op), ["create", "seed", "seedAgentTokens", "start", "seedAgentTokens"]);
  const c = [...driver.containers.values()][0];
  assert.deepEqual(c.agentTokens.map(a => a.id), ["kit-1"]);
  assert.equal(c.agentTokens[0].name, "alice");
  assert.equal(c.agentTokens[0].token.length, 43, "a base64url SHA-256 HMAC is 43 characters");
  // Reload happened once the computer was actually running (the second seedAgentTokens, from
  // reseedMembers after ensure(), triggers it -- the first, inside ensure() before start, must not).
  assert.deepEqual(server.calls.map(c2 => `${c2.method} ${c2.path}`), ["POST /agents/reload"]);
});

test("pool: addAgent to an already-running shared computer reseeds and reloads, without touching the existing member", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  ({ pool } = setup(t, { driver, memberTokenKey: () => Promise.resolve("k") }));

  const r1 = await pool.addAgent("browser-abc123", "kit-1", "alice");
  server.calls.length = 0; // only care about what the second add triggers

  const r2 = await pool.addAgent("browser-abc123", "kit-2", "bob");
  assert.equal(r2.computer, "browser-abc123");
  const c = [...driver.containers.values()][0];
  assert.deepEqual(c.agentTokens.map(a => a.id).sort(), ["kit-1", "kit-2"]);
  assert.deepEqual(server.calls.map(c2 => `${c2.method} ${c2.path}`), ["POST /agents/reload"]);
});

test("pool: addAgent refuses a computer id that already exists and is not a shared computer", async t => {
  const { pool } = setup(t);
  await pool.checkout("kit", { thread: "th-1" }); // "kit" is now a desktop-kind row
  await assert.rejects(pool.addAgent("kit", "kit-1", "alice"), /not a shared computer/);
});

test("pool: removeAgent, with others left, reseeds without them and reloads", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  ({ pool } = setup(t, { driver, memberTokenKey: () => Promise.resolve("k") }));
  const r1 = await pool.addAgent("browser-abc123", "kit-1", "alice");
  await pool.addAgent("browser-abc123", "kit-2", "bob");
  server.calls.length = 0;

  const r = await pool.removeAgent("browser-abc123", "kit-1");
  assert.deepEqual(r, { computer: "browser-abc123", stopped: false });
  const c = [...driver.containers.values()][0];
  assert.deepEqual(c.agentTokens.map(a => a.id), ["kit-2"], "the removed agent's token is still being written");
  assert.deepEqual(server.calls.map(c2 => `${c2.method} ${c2.path}`), ["POST /agents/reload"]);
  assert.equal(pool.row("browser-abc123").state, "running", "removing one of two members stopped the computer");
});

test("pool: removeAgent on the last member stops the container but never removes it or its volume", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  ({ pool } = setup(t, { driver, memberTokenKey: () => Promise.resolve("k") }));
  const r1 = await pool.addAgent("browser-abc123", "kit-1", "alice");

  const r = await pool.removeAgent("browser-abc123", "kit-1");
  assert.deepEqual(r, { computer: "browser-abc123", stopped: true });
  assert.equal(driver.calls.at(-1).op, "stop");
  assert.equal(pool.row("browser-abc123").state, "stopped");
  assert.equal(pool.members("browser-abc123").length, 0);
  assert.ok(!driver.calls.some(c => c.op === "remove"), "the container was removed, not just stopped");
});

test("pool: removeAgent refuses an agent that is not on the computer, and a computer id that is not shared", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  ({ pool } = setup(t, { driver, memberTokenKey: () => Promise.resolve("k") }));
  const r1 = await pool.addAgent("browser-abc123", "kit-1", "alice");
  await assert.rejects(pool.removeAgent("browser-abc123", "nobody"), /is not on/);
  await assert.rejects(pool.removeAgent("does-not-exist", "kit-1"), /not a shared computer/);
});

test("pool: disposeContext posts to /agents/dispose with the agent id, and never closes a live client on its own (that is closeAgent's job, not this one's)", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token, dispose: { disposed: true } });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  ({ pool } = setup(t, { driver, memberTokenKey: () => Promise.resolve("k") }));
  const r1 = await pool.addAgent("browser-abc123", "kit-1", "alice");

  const disposed = await pool.disposeContext("browser-abc123", "kit-1");
  assert.equal(disposed, true);
  const call = server.calls.find(c => c.path === "/agents/dispose");
  assert.deepEqual(call.body, { id: "kit-1" });
});

test("pool: with no memberTokenKey configured, addAgent refuses cleanly rather than seeding with no derivation key", async t => {
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: 1 } } });
  const { pool } = setup(t, { driver }); // no memberTokenKey
  await assert.rejects(pool.addAgent("browser-abc123", "kit-1", "alice"), /no member-token key configured/);
});

test("pool: re-adding a removed agent gets a NEW generation and a different derived token (reviewer LOW 1, 28 Sep)", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  ({ pool } = setup(t, { driver, memberTokenKey: () => Promise.resolve("k") }));

  const first = await pool.addAgent("browser-abc123", "kit-1", "alice");
  assert.equal(first.generation, 0);
  const firstToken = [...driver.containers.values()][0].agentTokens.find(a => a.id === "kit-1").token;

  await pool.removeAgent("browser-abc123", "kit-1");
  const second = await pool.addAgent("browser-abc123", "kit-1", "alice");
  assert.equal(second.generation, 1, "re-adding the same agent id reused its old generation");
  const secondToken = [...driver.containers.values()][0].agentTokens.find(a => a.id === "kit-1").token;
  assert.notEqual(secondToken, firstToken, "re-adding the same agent id re-derived the same token");
});

test("pool: an explicit rotate bumps the generation and reseeds a new token, without touching membership", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  ({ pool } = setup(t, { driver, memberTokenKey: () => Promise.resolve("k") }));
  await pool.addAgent("browser-abc123", "kit-1", "alice");
  const before = [...driver.containers.values()][0].agentTokens.find(a => a.id === "kit-1").token;
  const membersBefore = pool.members("browser-abc123");

  const r = await pool.rotateAgent("browser-abc123", "kit-1");
  assert.equal(r.generation, 1);
  const after = [...driver.containers.values()][0].agentTokens.find(a => a.id === "kit-1").token;
  assert.notEqual(after, before, "rotateAgent did not change the derived token");
  const membersAfter = pool.members("browser-abc123");
  assert.equal(membersAfter.length, membersBefore.length, "rotate changed who is a member");
  assert.equal(membersAfter[0].added_at, membersBefore[0].added_at, "rotate churned the membership row's own added_at");
});

test("pool: rotateAgent refuses an agent that is not on the computer, or a computer id that is not shared", async t => {
  const { pool } = setup(t, { driver: new FakeDriver(), memberTokenKey: () => Promise.resolve("k") });
  await assert.rejects(pool.rotateAgent("browser-abc123", "kit-1"), /not a shared computer/);
});

test("pool: addAgent refuses an agent that already belongs to a DIFFERENT shared computer (reviewer LOW 2, 28 Sep)", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  ({ pool } = setup(t, { driver, memberTokenKey: () => Promise.resolve("k") }));
  await pool.addAgent("browser-abc123", "kit-1", "alice");

  await assert.rejects(pool.addAgent("browser-xyz789", "kit-1", "alice"), /already a member of browser-abc123/);
  // The first computer's own membership, and its reseeded file, are untouched by the refused call.
  assert.deepEqual(pool.members("browser-abc123").map(m => m.agent_id), ["kit-1"]);
  assert.equal(pool.row("browser-xyz789"), null, "a refused addAgent still created the second computer's row");
});

test("pool: addAgent called again for an agent already on THIS SAME computer is fine (not a cross-computer conflict), and still bumps the generation", async t => {
  let pool;
  const computer = { id: "browser-abc123" };
  const server = await fakeComputerd({ bearer: () => pool.row(computer.id).helper_token });
  t.after(server.close);
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: server.port } } });
  ({ pool } = setup(t, { driver, memberTokenKey: () => Promise.resolve("k") }));
  await pool.addAgent("browser-abc123", "kit-1", "alice");
  const r = await pool.addAgent("browser-abc123", "kit-1", "alice-renamed");
  assert.equal(r.generation, 1);
  assert.equal(pool.members("browser-abc123")[0].agent_name, "alice-renamed");
});
