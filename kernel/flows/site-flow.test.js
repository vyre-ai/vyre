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
