// @ts-check
// A website Connection through the real vault: its credential has the host and the route rules and no key; a Flow's call is judged as any request is (route rules, class, hold, approval), and
// then goes to the browser instead of the network. A read runs at once; a send waits and is made once, only after the approval; the answer comes back like any provider's.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register } from "./request.js";
import { requestBind } from "../../kernel/seal/uses.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { siteDeclaration, siteConfig } from "../../records/connectors/site.js";
import { learnOperation } from "../../lib/siteops/learn.js";
import * as F from "../../lib/siteops/fixtures.js";

const ORIGIN = "https://app.example.com";
const read = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const send = () => learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"), examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/inbox` } }).operation;
const decl = siteDeclaration({ id: "linkedin", label: "LinkedIn", origin: ORIGIN, entries: [{ name: "searchPeople", kind: "read", op: read() }, { name: "sendMessage", kind: "send", op: send() }] });

async function mk(/** @type {any} */ t, /** @type {(q: any) => Promise<any>} */ siteRun) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-site-")), db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  /** @type {any[]} */ const network = [];
  const transport = async (/** @type {any} */ r) => { network.push(r); return { status: 200, headers: {}, body: Buffer.from("{}") }; };
  const tools = new Map(), tool = (/** @type {string} */ n, _c, _d, _i, /** @type {any} */ run) => tools.set(n, { run }), internal = (/** @type {string} */ n, _d, _i, /** @type {any} */ run) => tools.set(n, { run });
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, said, call: async (/** @type {string} */ name) => (name === "gate.offer" ? { data: {} } : name === "gate.request" ? { data: { id: "task_1", state: "held", message: "waiting for a person" } } : { error: { code: "no_such_tool", message: "no such tool" } }),
    deps: { siteRun, lookup: async () => [{ address: "93.184.216.10", family: 4 }], transport, now: () => 1_800_000_000_000 } });
  const run = (/** @type {string} */ n, /** @type {any} */ i, caller = "module:leases") => tools.get(n).run(i, { caller });
  await v.put({ name: "conn-linkedin", kind: "api-credential", fields: { config: JSON.stringify(siteConfig(decl)) } }, "cli");
  return { v, run, network };
}
const body = (/** @type {any} */ out) => JSON.parse(Buffer.from(out.body, "base64").toString());

test("the credential holds the host and the rules and no key; the catalog lists the operations and nothing secret", async t => {
  const m = await mk(t, async () => ({ status: 200, data: null }));
  const cat = (await m.run("vault.service.catalog", {})).connectors;
  assert.ok(cat["conn-linkedin"], "it is a connector");
  assert.deepEqual(Object.keys(cat["conn-linkedin"].operations).sort(), ["search_people", "send_message"]);
  assert.equal(cat["conn-linkedin"].operations.search_people.site.name, "searchPeople");
  assert.ok(!JSON.stringify(cat).includes("app.example.com") && !JSON.stringify(cat).includes(F.CSRF));
  const item = (await m.v.list({}, "cli")).find((/** @type {any} */ x) => x.name === "conn-linkedin");
  assert.equal(item.kind, "api-credential");
});

test("a read goes to the browser, not the network: the call is judged like any request, run at once, and its answer comes back as a provider's would", async t => {
  /** @type {any[]} */ const asked = [];
  const m = await mk(t, async q => { asked.push(q); return { status: 200, data: [{ name: `${q.query.query} one` }] }; });
  const r = await m.run("vault.service.forward", { connector: "conn-linkedin", request: { method: "GET", path: "/ops/search_people", query: { query: "gamma labs" } }, idem: "run1:s1" });
  assert.equal(r.status, 200);
  assert.deepEqual(body(r), [{ name: "gamma labs one" }]);
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].credential, asked[0].method, asked[0].path, asked[0].query, asked[0].approved], ["conn-linkedin", "GET", "/ops/search_people", { query: "gamma labs" }, false]);
  assert.equal(m.network.length, 0, "nothing went to the network");
  // a route the Connection does not declare is refused, and a read cannot be POSTed to
  await assert.rejects(m.run("vault.service.forward", { connector: "conn-linkedin", request: { method: "GET", path: "/anything/else" } }), /not open to this caller/);
  await assert.rejects(m.run("vault.service.forward", { connector: "conn-linkedin", request: { method: "POST", path: "/ops/search_people", body: {} } }), /not open to this caller/);
});

test("a send waits for the approval, is made once with it, and a replay gets the first answer", async t => {
  /** @type {any[]} */ const asked = [];
  const m = await mk(t, async q => { asked.push(q); return { status: 200, data: { sent: true } }; });
  const request = { method: "POST", path: "/ops/send_message", body: { recipient: "alan-turing", text: "a fresh note" } };
  const first = await m.run("vault.service.forward", { connector: "conn-linkedin", request, idem: "run2:s1" });
  assert.ok(first.held, JSON.stringify(first));
  assert.equal(asked.length, 0, "held: the browser was not asked");
  const bind = requestBind({ connector: "conn-linkedin", ...request });
  const done = await m.run("vault.service.forward", { connector: "conn-linkedin", request, idem: "run2:s1", approval: "appr_1", bind });
  assert.equal(done.status, 200);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].approved, true);
  assert.deepEqual(asked[0].path, "/ops/send_message");
  const again = await m.run("vault.service.forward", { connector: "conn-linkedin", request, idem: "run2:s1", approval: "appr_1", bind });
  assert.equal(again.status, 200);
  assert.equal(asked.length, 1, "never a second send");
});

test("a failure in the browser comes back as the status it says; a missing browser is a plain refusal", async t => {
  const m = await mk(t, async () => ({ status: 401, data: { error: { class: "auth", reason: "sign in again" } } }));
  const r = await m.run("vault.service.forward", { connector: "conn-linkedin", request: { method: "GET", path: "/ops/search_people", query: { query: "gamma labs" } } });
  assert.equal(r.status, 401);
  assert.equal(body(r).error.class, "auth");
  const none = await mk(t, /** @type {any} */ (undefined));
  await assert.rejects(none.run("vault.service.forward", { connector: "conn-linkedin", request: { method: "GET", path: "/ops/search_people", query: { query: "gamma labs" } } }), /no browser is connected/);
});
