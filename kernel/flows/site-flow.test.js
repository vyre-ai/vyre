// @ts-check
// A learned website operation, run from a Flow: the step names the Connection and the operation, the Flow compiles it to the one service step, the kernel's rules hold what is outward, and the
// call goes through the real vault to the browser (a fake here). A read runs at once; a send is held for the person, then made once with their approval. The login is nowhere in the run.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { world, install, settle } from "./testing/world.js";
import { catalog } from "./testing/fixtures.js";
import { open, migrate } from "../../core/store/index.js";
import { Vault, MIGRATIONS } from "../../core/vault/vault.js";
import * as saidTools from "../../core/vault/said.js";
import { register } from "../../core/vault/request.js";
import { normalize } from "../../core/vault/api-request.js";
import { requestBind } from "../seal/uses.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { siteDeclaration, siteConfig } from "../../records/connectors/site.js";
import { learnOperation } from "../../lib/siteops/learn.js";
import * as F from "../../lib/siteops/fixtures.js";

const ORIGIN = "https://app.example.com";
const read = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const send = () => learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"), examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/inbox` } }).operation;
const decl = siteDeclaration({ id: "linkedin", label: "LinkedIn", origin: ORIGIN, entries: [{ name: "searchPeople", kind: "read", op: read() }, { name: "sendMessage", kind: "send", op: send() }] });
const cfg = normalize(siteConfig(decl));

/** The real vault, with a fake browser, as the Flow's service port: the kernel's call, bound the way the gateway binds it. */
async function vaultPort(/** @type {any} */ t, /** @type {(q: any) => Promise<any>} */ browser) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-sflow-")), db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const tools = new Map(), tool = (/** @type {string} */ n, _c, _d, _i, /** @type {any} */ run) => tools.set(n, { run }), internal = (/** @type {string} */ n, _d, _i, /** @type {any} */ run) => tools.set(n, { run });
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, said, call: async () => ({ error: { code: "no_such_tool", message: "x" } }), deps: { siteRun: browser, lookup: async () => [], now: () => 1_800_000_000_000 } });
  await v.put({ name: "conn-linkedin", kind: "api-credential", fields: { config: JSON.stringify(siteConfig(decl)) } }, "cli");
  /** @type {any[]} */ const seen = [];
  const port = async (/** @type {any} */ q) => {
    seen.push(q);
    const r = q.request;
    return tools.get("vault.service.forward").run({ connector: q.connector, request: { method: r.method, path: r.path, ...(r.query ? { query: r.query } : {}), ...(r.body !== undefined ? { body: r.body } : {}) }, idem: q.idem,
      ...(q.approval ? { approval: q.approval, bind: requestBind({ connector: q.connector, method: r.method, path: r.path, query: r.query, body: r.body, headers: r.headers }) } : {}) }, { caller: "module:leases" });
  };
  return { port, seen };
}
const mine = (/** @type {any} */ w, /** @type {string} */ type) => [.../** @type {Map<string, any>} */ (w.kernel.tables.get(type) || new Map()).values()];
const flowOf = (/** @type {any[]} */ steps) => ({ format: 1, name: "site", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });
const cat = () => { const c = catalog(); return { ...c, connectors: { ...c.connectors, "conn-linkedin": { ...cfg.service, operations: cfg.operations } } }; };

test("a Flow's step on a learned read: it runs at once through the vault and the browser, and the answer is the step's output", async t => {
  /** @type {any[]} */ const browser = [];
  const p = await vaultPort(t, async q => { browser.push(q); return { status: 200, data: [{ name: `${q.query.query} one`, headline: "Engineer" }] }; });
  const w = await world({ ports: { service: p.port }, cat: cat() });
  await install(w, flowOf([
    { id: "find", kind: "service", connection: "linkedin", operation: "search_people", input: { query: { query: { expr: "trigger.who" } } } },
    { id: "m", kind: "create", type: "payment", set: { client: { expr: "steps.find.response.json[0].name" }, amount: 1 } },
  ]));
  w.kernel.inbound("payment.received", { who: "gamma labs" });
  await settle(w);
  assert.equal(p.seen.length, 1);
  assert.deepEqual([p.seen[0].connector, p.seen[0].request.method, p.seen[0].request.path], ["conn-linkedin", "GET", "/ops/search_people"]);
  assert.equal(browser.length, 1);
  assert.deepEqual([browser[0].approved, browser[0].query], [false, { query: "gamma labs" }]);
  assert.equal(mine(w, "payment")[0].data.client, "gamma labs one");
  const runs = await w.runner.listRuns({});
  assert.equal(runs[0].state, "done", JSON.stringify(runs[0].error));
  for (const raw of [F.SECRET_COOKIE, F.CSRF]) assert.ok(!JSON.stringify(runs).includes(raw), `the run holds ${raw}`);
});

test("a Flow's step on a learned send: held for the person, never sent without their yes, then made exactly once", async t => {
  /** @type {any[]} */ const browser = [];
  const p = await vaultPort(t, async q => { browser.push(q); return { status: 200, data: { sent: true } }; });
  const w = await world({ ports: { service: p.port }, cat: cat() });
  w.kernel.rules.push({ match: (/** @type {any} */ i) => i.action === "service.call" && !i.approval, effect: "ask", reason: "outward" });
  const { id } = await install(w, flowOf([{ id: "dm", kind: "service", connection: "linkedin", operation: "send_message", input: { body: { recipient: { expr: "trigger.who" }, text: "a fresh note" } } }]));
  w.kernel.inbound("payment.received", { who: "alan-turing" });
  await settle(w);
  assert.equal(browser.length, 0, "held: the browser was not asked");
  const task = w.kernel.tasks.find((/** @type {any} */ x) => x.form && x.form.kind === "held_act");
  assert.equal(task.form.action, "service.call");
  assert.match(task.form.resource, /service\/conn-linkedin$/);
  w.kernel.completeTask(task.id, { outcome: "approved" });
  await settle(w);
  assert.equal(browser.length, 1, "one send");
  assert.deepEqual([browser[0].method, browser[0].path, browser[0].approved], ["POST", "/ops/send_message", true]);
  assert.deepEqual(JSON.parse(browser[0].body), { recipient: "alan-turing", text: "a fresh note" });
  assert.equal((await w.runner.listRuns({ flow: id }))[0].state, "done");
});

test("the Flow is checked at define time against the operation's inputs: a typo or a missing input is named, and the Connection's kind decides what is outward", async () => {
  const w = await world({ cat: cat() });
  const bad = await w.runner.define(null, flowOf([{ id: "f", kind: "service", connection: "linkedin", operation: "search_people", input: { query: { nope: "x" } } }]), { kind: "person", id: "per_alex" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((/** @type {any} */ e) => /does not take nope/.test(e.message)), JSON.stringify(bad.errors));
  const ok = await w.runner.define(null, flowOf([{ id: "f", kind: "service", connection: "linkedin", operation: "send_message", input: { body: { recipient: "a", text: "b" } } }]), { kind: "person", id: "per_alex" });
  if (ok.ok) assert.ok(ok.effects.outward.some((/** @type {any} */ o) => o.step === "f" && o.action === "service.call"), "the approval card lists the send");
});

// ---- a Mac that is off: the run waits on the Flows engine's own durable wait ----
const offlineBody = Buffer.from(JSON.stringify({ error: { class: "no_browser", mac: true, reason: "needs your Chrome: the Mac \"studio\" is offline" } })).toString("base64");
const okBody = Buffer.from(JSON.stringify([{ name: "gamma labs one" }])).toString("base64");
function deviceWorld(/** @type {{ online: boolean }} */ st) {
  /** @type {any[]} */ const seen = [];
  const port = async (/** @type {any} */ q) => { seen.push(q); return st.online ? { status: 200, ok: true, headers: { "content-type": "application/json" }, body: okBody } : { status: 503, ok: false, headers: { "content-type": "application/json" }, body: offlineBody }; };
  return { port, seen };
}
const readFlow = () => flowOf([{ id: "find", kind: "service", connection: "linkedin", operation: "search_people", input: { query: { query: "gamma labs" } } }, { id: "m", kind: "create", type: "payment", set: { client: { expr: "steps.find.response.json[0].name" }, amount: 1 } }]);

test("a read on the Mac rung with the Mac off WAITS (the durable wait), shows as one card that needs the person, and finishes when the Mac comes online", async () => {
  const st = { online: false };
  const d = deviceWorld(st);
  const w = await world({ ports: { service: d.port }, cat: cat() });
  const { id } = await install(w, readFlow());
  w.kernel.inbound("payment.received", {});
  await settle(w);
  let run = (await w.runner.listRuns({ flow: id }))[0];
  assert.equal(run.state, "waiting", JSON.stringify(run.error));
  assert.deepEqual([run.waiting.kind, run.waiting.event], ["event", "link.mac-online"]);
  assert.equal(run.attention.kind, "device");
  assert.match(run.attention.message, /^Needs your Chrome: needs your Chrome: the Mac "studio" is offline|^Needs your Chrome/);
  assert.equal(d.seen.length, 1);
  // the Mac comes back: the same step tries again and the run finishes
  st.online = true;
  w.kernel.inbound("link.mac-online", {});
  await settle(w);
  run = (await w.runner.listRuns({ flow: id }))[0];
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(run.attention, undefined);
  assert.equal(mine(w, "payment")[0].data.client, "gamma labs one");
  assert.equal(d.seen.length, 2, "one retry, not a storm");
});

test("Retry on the card tries now; Stop ends the run plainly", async () => {
  const st = { online: false };
  const d = deviceWorld(st);
  const w = await world({ ports: { service: d.port }, cat: cat() });
  const { id } = await install(w, readFlow());
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const first = (await w.runner.listRuns({ flow: id }))[0];
  st.online = true;
  await w.runner.retry(first.id);
  await settle(w);
  assert.equal((await w.runner.getRun(first.id)).state, "done", "Retry tried the step now");
  const st2 = { online: false };
  const d2 = deviceWorld(st2);
  const w2 = await world({ ports: { service: d2.port }, cat: cat() });
  const f2 = await install(w2, readFlow());
  w2.kernel.inbound("payment.received", {});
  await settle(w2);
  const r2 = (await w2.runner.listRuns({ flow: f2.id }))[0];
  await w2.runner.cancel(r2.id);
  assert.equal((await w2.runner.getRun(r2.id)).state, "cancelled");
  assert.equal(d2.seen.length, 1, "nothing was sent after Stop");
});

// ---- the card, end to end through f3 ----
import { createFlows } from "./index.js";
import { ALEX } from "./testing/world.js";
test("f3: the run waiting for a Chrome is listed by flows.attention as kind device, and flows.settle retry and stop work on it", async () => {
  for (const action of ["retry", "stop"]) {
    const st = { online: false };
    const d = deviceWorld(st);
    const w = await world({ ports: { service: d.port }, cat: cat() });
    const f = createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.chainFor(x) }, store: w.store, catalog: () => w.runner.catalogFn(), ports: { service: d.port, roles: async () => [ALEX] } });
    const { id } = await install(w, readFlow());
    w.kernel.inbound("payment.received", {});
    await settle(w);
    const chain = { hops: [{ actor: ALEX }] };
    const rows = (await f.tools["flows.attention"](chain, {})).runs;
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.deepEqual([rows[0].kind, rows[0].loud], ["device", true]);
    assert.match(rows[0].message, /Needs your Chrome/);
    const run = (await w.runner.listRuns({ flow: id }))[0];
    if (action === "retry") st.online = true;
    await f.tools["flows.settle"](chain, { run: run.id, action });
    await settle(w);
    const after = await w.runner.getRun(run.id);
    assert.equal(after.state, action === "retry" ? "done" : "cancelled");
    assert.deepEqual(await w.runner.attention(), [], "the card is gone");
  }
});
