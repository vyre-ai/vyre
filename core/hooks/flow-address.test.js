// @ts-check
// A Flow's own webhook address, on a real daemon with the real Flows, Vault and hooks listener. Turning a Flow on opens its address (one route, bound to it by id, the token scheme) and turns the listener
// on; turning it off closes it; "Get a new address" makes the old one stop working; Send a test checks the address and starts nothing; a form post reaches a form Flow; the limits hold; and the token is in
// no log line, event or config file.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const canonical = (/** @type {any} */ x) => JSON.stringify(x, Object.keys(x).sort());
const signedPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };

const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(what); await new Promise(r => setTimeout(r, 100)); } };

async function world(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false }, projectsDir: path.join(root, "projects"), vault: { keystore: "file" }, hooks: { port: 0 } }));
  /** @type {string[]} */ const logs = [];
  const d = await start({ root, presence: present, log: (/** @type {any} */ l) => logs.push(String(l)), kernel: true, kernelPresence: signedPresence() });
  t.after(() => d.stop().catch(() => {}));
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  /** A tool call that must succeed, as the person at their own command line. */
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli") => { const r = await d.registry.call(tool, input, caller, {}); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  const define = async (/** @type {any} */ flow) => { const r = await d.registry.call("flows.define", { flow }, "cli", await meta()); assert.equal(r.error, undefined, JSON.stringify(r.error)); assert.ok(r.data.ok, JSON.stringify(r.data)); return r.data; };
  const approve = (/** @type {any} */ def) => host.flows.tools["flows.approve"](host.personChain(), { id: def.id, version: def.version, hash: def.hash });
  const runs = async (/** @type {string} */ flow) => host.flows.runner.listRuns({ flow });
  const port = async () => (await call("hooks.list")).port;
  return { d, root, logs, host, call, define, approve, runs, port };
}

/** POST to the listener; resolves to the status code. */
function post(/** @type {number} */ port, /** @type {string} */ at, body = '{"amount":80,"name":"Sam Lee"}', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: at, headers: { "content-type": "application/json", ...headers } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end(body);
  });
}

const steps = [{ id: "pause", kind: "wait", for_ms: 3_600_000 }];

test("turning a Flow on opens its own address and the listener; a delivery starts that Flow as outside data; off closes it; a new address ends the old one", { timeout: 180_000 }, async t => {
  const w = await world(t);
  const def = await w.define({ format: 1, name: "orders_in", label: "Orders in", authorship: "human", trigger: { on: "web", path: "hook", address: true }, steps });
  const before = await w.call("hooks.flow", { flow: def.id });
  assert.equal(before.open, false);
  assert.match(before.why, /Turn the Flow on/);
  assert.equal((await w.call("hooks.list")).listening, false, "nothing listens before a Flow asks");

  await w.approve(def);
  const h = await until(async () => { const r = await w.call("hooks.flow", { flow: def.id }); return r.open ? r : null; }, "the Flow's address to open");
  const m = /^\/hooks\/(orders-in)-([0-9a-f]{64})$/.exec(h.address.path);
  assert.ok(m, h.address.path);
  const [, key, token] = m;
  assert.equal(h.address.url, null, "no public address in a test home");
  assert.match(h.why, /public address/);
  const list = await w.call("hooks.list");
  assert.equal(list.listening, true, "the Flow's yes turned the listener on");
  const row = list.routes.find((/** @type {any} */ r) => r.flow === def.id);
  assert.equal(row.name, key);
  assert.equal(JSON.stringify(list).includes(token), false, "hooks.list shows no token");
  for (const caller of ["mcp", "harness", "mcp:agent:kit", "module:watchers", "tailnet-guest:sam@example.com"]) {
    const r = await w.d.registry.call("hooks.flow", { flow: def.id }, caller, {});
    assert.ok(r.error, `${caller} read the address`);
  }
  const port = await w.port();

  // The address with its token, and the bare route with Authorization: Bearer.
  assert.equal(await post(port, h.address.path), 200);
  assert.equal(await post(port, `/hooks/${key}`, '{"amount":81,"name":"Ana Ruiz"}', { authorization: `Bearer ${token}` }), 200);
  const started = await until(async () => { const r = await w.runs(def.id); return r.length === 2 ? r : null; }, "two runs");
  const first = started.find((/** @type {any} */ r) => r.trigger.input && r.trigger.input.amount === 80);
  assert.ok(first, JSON.stringify(started.map((/** @type {any} */ r) => r.trigger)));
  assert.equal(first.trigger.input.name, "Sam Lee");
  assert.equal(first.tainted, true, "the payload is outside data");

  // Wrong, short and missing tokens are the same 404, and each is logged with its reason and size.
  const wrong = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
  assert.equal(await post(port, `/hooks/${key}-${wrong}`), 404);
  assert.equal(await post(port, `/hooks/${key}-${token.slice(0, 32)}`), 404);
  assert.equal(await post(port, `/hooks/${key}`), 404);
  assert.equal(await post(port, `/hooks/${key}`, "{}", { authorization: "Bearer nope" }), 404);
  assert.ok(w.logs.some(l => new RegExp(`internet:${key}: refused, the token does not match \\(\\d+ bytes\\)`).test(l)), w.logs.join("\n"));
  assert.ok(w.logs.some(l => new RegExp(`internet:${key}: refused, no token`).test(l)));
  assert.equal((await w.runs(def.id)).length, 2, "a refused delivery started nothing");
  const last = (await w.call("hooks.flow", { flow: def.id })).last;
  assert.equal(last.ok, false);
  assert.ok(last.bytes > 0);

  // Send a test: checked like any delivery, starts nothing.
  const tested = await w.call("hooks.flow.test", { flow: def.id });
  assert.equal(tested.ok, true, tested.line);
  assert.equal((await w.call("hooks.flow", { flow: def.id })).last.test, true);
  assert.equal((await w.runs(def.id)).length, 2, "a test starts nothing");

  // A new address: the old token stops working at once.
  const renewed = await w.call("hooks.flow.renew", { flow: def.id });
  assert.notEqual(renewed.address.path, h.address.path);
  assert.equal(await post(port, h.address.path, '{"amount":82}'), 404, "the old address still works");
  assert.equal(await post(port, renewed.address.path, '{"amount":83}'), 200);
  const newToken = renewed.address.path.split("-").pop();

  // Off closes it; on again opens the same address.
  await w.host.flows.tools["flows.pause"](w.host.personChain(), { id: def.id });
  await until(async () => !(await w.call("hooks.flow", { flow: def.id })).open, "the address to close when the Flow is off");
  assert.equal(await post(port, renewed.address.path, '{"amount":84}'), 404);
  await w.host.flows.tools["flows.resume"](w.host.personChain(), { id: def.id });
  const again = await until(async () => { const r = await w.call("hooks.flow", { flow: def.id }); return r.open ? r : null; }, "the address to open again");
  assert.equal(again.address.path, renewed.address.path, "the same address while the Flow is the same");

  // The token is in no log line, event or config file.
  const events = w.d.registry.deps.events.since(0, { limit: 100000 }).map((/** @type {any} */ e) => JSON.stringify(e)).join("\n");
  const everything = [w.logs.join("\n"), events, fs.readFileSync(path.join(w.root, "config.json"), "utf8")].join("\n");
  for (const s of [token, newToken]) assert.equal(everything.includes(s), false, "a token was logged or stored outside the Vault");
});

test("a form post reaches a form Flow as its fields; a Flow that asks for no address gets none", { timeout: 180_000 }, async t => {
  const w = await world(t);
  const form = await w.define({ format: 1, name: "contact_form", label: "Contact form", authorship: "human", trigger: { on: "web", path: "contact", address: true }, steps });
  const plain = await w.define({ format: 1, name: "plain_web", label: "Plain web", authorship: "human", trigger: { on: "web", path: "plain" }, steps });
  await w.approve(form);
  await w.approve(plain);
  const h = await until(async () => { const r = await w.call("hooks.flow", { flow: form.id }); return r.open ? r : null; }, "the form Flow's address");
  assert.match(h.address.path, /^\/hooks\/contact-form-[0-9a-f]{64}$/);
  assert.equal((await w.call("hooks.flow", { flow: plain.id })).open, false, "a web trigger without address opened a public route");
  const port = await w.port();
  assert.equal(await post(port, h.address.path, "name=Sam+Lee&email=sam%40example.com&topic=a&topic=b", { "content-type": "application/x-www-form-urlencoded" }), 200);
  const [run] = await until(async () => { const r = await w.runs(form.id); return r.length ? r : null; }, "the form Flow to start");
  assert.equal(run.trigger.input.name, "Sam Lee");
  assert.deepEqual(run.trigger.input.topic, ["a", "b"], "a field sent twice is a list");
  assert.equal(run.tainted, true);
  assert.equal((await w.runs(plain.id)).length, 0);
});

test("the limits: a body cap, JSON or form only, a per-route rate limit, each refusal logged with its reason and size", { timeout: 180_000 }, async t => {
  const w = await world(t);
  const def = await w.define({ format: 1, name: "intake_in", label: "Intake in", authorship: "human", trigger: { on: "web", path: "hook", address: true }, steps });
  await w.approve(def);
  const h = await until(async () => { const r = await w.call("hooks.flow", { flow: def.id }); return r.open ? r : null; }, "the address");
  const port = await w.port();
  const key = h.address.path.split("/")[2].replace(/-[0-9a-f]{64}$/, "");
  assert.equal(await post(port, h.address.path, JSON.stringify({ pad: "x".repeat(300 * 1024) })), 413);
  assert.equal(await post(port, h.address.path, "<xml/>", { "content-type": "text/xml" }), 415);
  assert.ok(w.logs.some(l => new RegExp(`internet:${key}: refused, bigger than 256 KB \\(\\d+ bytes\\)`).test(l)), w.logs.join("\n"));
  assert.ok(w.logs.some(l => new RegExp(`internet:${key}: refused, not JSON or a form \\(6 bytes\\)`).test(l)));
  const codes = [];
  for (let i = 0; i < 30; i++) codes.push(await post(port, `/hooks/${key}-${"0".repeat(64)}`, "{}"));
  assert.ok(codes.includes(429), `no 429 in ${codes.join(",")}`);
  assert.equal(codes.filter(c => c !== 404 && c !== 429).length, 0, codes.join(","));
  assert.ok(w.logs.some(l => new RegExp(`internet:${key}: refused, over the limit of 30 a minute`).test(l)));
  assert.equal((await w.runs(def.id)).length, 0, "nothing refused started the Flow");
});
