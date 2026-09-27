// @ts-check
// Each computer as its own tailnet node, from vyred's side: the pool on the fake driver, pointed
// at a fake computerd on loopback that answers the three tailnet routes, a stubbed vault, and the
// real DockerDriver + policy.js for the create body the restricted proxy would check.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Pool, MIGRATIONS } from "./pool.js";
import { FakeDriver } from "./driver/fake.js";
import { DockerDriver } from "./driver/docker.js";
import { allowCreate } from "./driver/policy.js";
import { setting, hostname } from "./tailnet.js";
import { tempHome } from "../../test/helpers.js";

const KEY = "tskey-auth-kFAKE0CNTRL-0123456789abcdef";
const AGENTS = [{ name: "kit", kind: "agent", computer: true }];

/**
 * A fake computerd: GET /tailnet, POST /tailnet/up and /tailnet/down, every request written down.
 * @param {any} t @param {{ missing?: boolean, ready?: boolean }} [o]
 */
async function computerd(t, o = {}) {
  /** @type {Array<{ method: string, path: string, auth: string, body: any }>} */
  const seen = [];
  const node = { running: false };
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: String(req.method), path: String(req.url), auth: String(req.headers.authorization || ""), body });
    const send = (status, b) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (o.missing) return send(404, { error: { message: `no such route: ${req.method} ${req.url}` } });
    if (req.method === "GET" && req.url === "/tailnet") {
      if (o.ready === false) return send(200, { ready: false, why: "this runs as uid 1000, not root", running: false });
      return send(200, node.running ? { ready: true, running: true, stableId: "nKit7CNTRL", node: "vyre-agent-kit.tail0000.ts.net" } : { ready: true, running: false });
    }
    if (req.method === "POST" && req.url === "/tailnet/up") { node.running = true; return send(200, { stableId: "nKit7CNTRL", node: "vyre-agent-kit.tail0000.ts.net" }); }
    if (req.method === "POST" && req.url === "/tailnet/down") { node.running = false; return send(200, { down: true }); }
    send(404, { error: { message: "no such route" } });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { port: /** @type {any} */ (server.address()).port, seen, node };
}

/** A one-request fake Engine on a unix socket: the create body DockerDriver really sends. */
async function engine(t, root) {
  const socket = path.join(root, "d.sock");
  /** @type {any[]} */
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    bodies.push(raw ? JSON.parse(raw) : undefined);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ Id: "c1" }));
  });
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { socket, bodies };
}

/**
 * The pool, with the fake computerd at the fake driver's one local address. Every create the pool
 * asks for also goes through the real DockerDriver to the fake Engine, so the test can hold the
 * body the proxy would check.
 */
async function setup(t, { enabled = true, missing = false, ready = true, port = true } = {}) {
  const root = tempHome(t);
  const db = open(path.join(root, "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const cd = await computerd(t, { missing, ready });
  // The tailnet side on its own port, as the driver would name it; computerd's port is a closed one.
  const driver = new FakeDriver({ local: { host: "127.0.0.1", ports: { helper: 9, ...(port ? { tailnet: cd.port } : {}) } } });
  const e = await engine(t, root);
  const docker = new DockerDriver({ url: `unix://${e.socket}`, labelPrefix: "vyre", network: "vyre-computers" });
  const create = driver.create.bind(driver);
  driver.create = async spec => { await docker.create(spec); return create(spec); };
  /** @type {Array<{ type: string, payload: any }>} */
  const events = [];
  /** @type {string[]} */
  const logs = [];
  const fetched = { n: 0 };
  const call = async tool => tool === "agents.list" ? { data: AGENTS } : { error: { code: "no_such_tool", message: tool } };
  const tailnet = { setting: () => setting({ enabled }), key: async () => { fetched.n += 1; return KEY; } };
  const pool = new Pool({ db, driver, call, emit: (type, payload) => { events.push({ type, payload }); }, log: m => logs.push(m),
    config: { waitMs: 200 }, tailnet, wait: async () => {} });
  const joined = async agent => { const j = pool.joins.get(agent); if (j) await j.done; };
  return { pool, driver, cd, events, logs, fetched, bodies: e.bodies, joined, types: () => events.map(x => x.type) };
}

test("tailnet: off, a computer starts and stops without a single tailnet call or vault fetch", async t => {
  const s = await setup(t, { enabled: false });
  await s.pool.checkout("kit");
  await s.joined("kit");
  await s.pool.stop("kit");
  assert.deepEqual(s.cd.seen, [], "computerd was asked about the tailnet");
  assert.equal(s.fetched.n, 0, "the vault was asked for the key");
  assert.ok(!s.types().some(x => x === "computer.joined" || x === "computer.left"));
});

test("tailnet: on, a started computer joins with the key in one POST body, and the key is nowhere in the create", async t => {
  const s = await setup(t);
  await s.pool.checkout("kit");
  await s.joined("kit");
  const token = String(s.pool.row("kit").helper_token);
  assert.deepEqual(s.cd.seen.map(r => `${r.method} ${r.path}`), ["GET /tailnet", "POST /tailnet/up"]);
  assert.ok(s.cd.seen.every(r => r.auth === `Bearer ${token}`), "a tailnet call went without computerd's token");
  assert.deepEqual(s.cd.seen[1].body, { authKey: KEY, hostname: hostname("kit"), tag: "tag:vyre-agent" });
  assert.equal(s.fetched.n, 1);
  assert.deepEqual(s.events.find(x => x.type === "computer.joined")?.payload, { agent: "kit", node: "vyre-agent-kit.tail0000.ts.net", stableId: "nKit7CNTRL" });
  // The create the proxy checks: unchanged by the switch (policy.js was not widened), and no key.
  assert.equal(s.bodies.length, 1);
  assert.deepEqual(allowCreate(s.bodies[0], { network: "vyre-computers", image: "vyre/computer:0.1", labelPrefix: "vyre" }), { ok: true });
  assert.ok(!JSON.stringify(s.bodies[0]).includes(KEY), "the key was in the create body");
  assert.ok(!s.bodies[0].Env.some(e => /TAILSCALE|AUTHKEY|TS_/.test(e)), "a tailnet variable reached the container's env");
  const spec = [...s.driver.containers.values()][0].spec;
  assert.deepEqual(Object.keys(spec.env).sort(), ["SCREEN"]);
  assert.ok(!JSON.stringify(spec).includes(KEY));
  assert.ok(!JSON.stringify(s.events).includes(KEY) && !s.logs.join("\n").includes(KEY), "the key was in an event or a log line");
});

test("tailnet: the node maps to the agent only while its computer runs, and a clean stop logs it out", async t => {
  const s = await setup(t);
  await s.pool.checkout("kit");
  await s.joined("kit");
  assert.equal(s.pool.agentOfNode("nKit7CNTRL"), "kit");
  assert.equal(s.pool.agentOfNode("nSomeoneElse"), null, "an unrecorded node mapped to an agent");
  assert.equal(s.pool.agentOfNode(""), null);
  s.pool.release("kit");
  assert.equal(await s.pool.freeze("kit"), true);
  assert.equal(s.pool.agentOfNode("nKit7CNTRL"), null, "a frozen computer's node still mapped");
  // Thawed, it is asked first with no key; its node is still up, so no key is fetched again.
  await s.pool.checkout("kit");
  await s.joined("kit");
  assert.equal(s.fetched.n, 1, "a thaw fetched the key although the node was still up");
  assert.equal(s.types().filter(x => x === "computer.joined").length, 1, "the same node joined twice");
  assert.equal(s.pool.agentOfNode("nKit7CNTRL"), "kit");
  await s.pool.stop("kit");
  assert.equal(s.cd.seen.at(-1)?.path, "/tailnet/down");
  assert.equal(s.cd.node.running, false);
  assert.deepEqual(s.events.at(-2), { type: "computer.left", payload: { agent: "kit" } });
  assert.equal(s.pool.agentOfNode("nKit7CNTRL"), null);
  assert.equal(s.pool.row("kit").stable_id, null);
});

test("tailnet: a vanished computer's node maps to no one", async t => {
  const s = await setup(t);
  await s.pool.checkout("kit");
  await s.joined("kit");
  s.driver.containers.clear();
  await s.pool.reconcile();
  assert.equal(s.pool.agentOfNode("nKit7CNTRL"), null);
  assert.ok(s.types().includes("computer.left"));
});

test("tailnet: an image with no tailnet side, or one that cannot run it, never gets the key", async t => {
  for (const o of [{ missing: true }, { ready: false }]) {
    const s = await setup(t, o);
    await s.pool.checkout("kit");
    await s.joined("kit");
    assert.equal(s.fetched.n, 0, `the key was fetched for ${JSON.stringify(o)}`);
    assert.deepEqual(s.cd.seen.map(r => `${r.method} ${r.path}`), ["GET /tailnet"]);
    assert.ok(s.logs.some(l => /did not join the tailnet: .*the key was not sent/.test(l)), s.logs.join("\n"));
    assert.equal(s.pool.agentOfNode("nKit7CNTRL"), null);
  }
});

test("tailnet: with no tailnet port from the driver, nothing is called and the key stays in the vault", async t => {
  // Today's image: computerd is the only thing listening, and it runs as the agent's uid, so an
  // agent could stop it and answer GET /tailnet itself. The key never goes there.
  const s = await setup(t, { port: false });
  await s.pool.checkout("kit");
  await s.joined("kit");
  await s.pool.stop("kit");
  assert.deepEqual(s.cd.seen, []);
  assert.equal(s.fetched.n, 0);
  assert.ok(s.logs.some(l => /no tailnet side apart from the agent's user .*the key was not sent/.test(l)), s.logs.join("\n"));
});

test("tailnet: config computers.tailnet is checked, and anything but enabled: true is off", () => {
  assert.deepEqual(setting(undefined), { enabled: false, tag: "tag:vyre-agent" });
  assert.deepEqual(setting({ enabled: "yes" }), { enabled: false, tag: "tag:vyre-agent" });
  assert.deepEqual(setting({ enabled: true, tag: "tag:northwind-agents" }), { enabled: true, tag: "tag:northwind-agents" });
  assert.throws(() => setting({ enabled: true, tag: "autogroup:member" }), /is not a tag/);
});
