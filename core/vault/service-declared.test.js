// @ts-check
// A declared connector (records/connectors) through the real vault: the declaration becomes an api-credential, the Flow-facing catalog carries its extra fields, an outward call carries the
// provider's idempotency header (derived from the call's idem key, never the key itself), a replay with a new approval still reaches the provider as the same act, and an op that opts out sends
// no header. The provider is a fake Stripe and a fake Google on the transport; DNS and the clock are fakes too.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register } from "./request.js";
import { requestBind } from "../../kernel/seal/uses.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { DECLARATIONS } from "../../records/connectors/index.js";
import { fakeGoogle, TOKEN } from "../../records/testing/fake-google.js";
import { toCredentialConfig, buildRequest, opFor, readbackRequest, compareReadback } from "../../records/connectors/format.js";
import { fakeStripe, KEY } from "../../records/testing/fake-stripe.js";

const stripe = DECLARATIONS.stripe;

async function mk(t, fakes) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-decl-")), db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const net = { calls: /** @type {any[]} */ ([]) };
  const transport = async r => {
    const f = fakes[r.url.hostname];
    const out = f.handle({ method: r.method, url: r.url, headers: r.headers, body: r.body });
    net.calls.push({ host: r.url.hostname, method: r.method, path: r.url.pathname, headers: r.headers });
    return { status: out.status, headers: out.headers, body: Buffer.from(out.body) };
  };
  const tools = new Map(), tool = (n, c, d, i, run) => tools.set(n, { run }), internal = (n, d, i, run) => tools.set(n, { run });
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, call: async tool => (tool === "gate.offer" ? { data: {} } : tool === "gate.request" ? { data: { id: "task_1", state: "held", message: "waiting for a person" } } : { error: { code: "no_such_tool", message: "no such tool" } }), said, deps: { lookup: async () => [{ address: "203.0.113.10", family: 4 }], transport, now: () => 1_800_000_000_000 } });
  const run = (n, i, caller = "module:leases") => tools.get(n).run(i, { caller });
  return { v, net, run, db };
}
const install = (m, name, decl, secret, o = {}) => m.v.put({ name, kind: "api-credential", fields: { config: JSON.stringify(toCredentialConfig(decl, o)), secret } }, "cli");
const body = out => JSON.parse(Buffer.from(out.body, "base64").toString());
/** an outward call as the kernel releases it after a person's yes */
const approved = (m, connector, request, idem, id) => m.run("vault.service.forward", { connector, request, idem, approval: id, bind: requestBind({ connector, ...request }) });

test("a declaration installed in the vault is a connector: the catalog carries its draft, idempotency, rate and ops, and a read runs with the key added", async t => {
  const fs_ = fakeStripe();
  const m = await mk(t, { "api.stripe.com": fs_ });
  await install(m, "stripe", stripe, KEY);
  const cat = (await m.run("vault.service.catalog", {})).connectors;
  assert.ok(cat.stripe, "stripe is a connector");
  assert.deepEqual(cat.stripe.idempotency, { header: "Idempotency-Key" });
  assert.deepEqual(cat.stripe.rate, { per_minute: 6000, retry_after: true });
  assert.equal(cat.stripe.ops.find(o => o.name === "refunds.create").outward, true);
  assert.equal(cat.stripe.ops.find(o => o.name === "customers.list").read, true);
  assert.ok(!JSON.stringify(cat).includes(KEY) && !JSON.stringify(cat).includes("api.stripe.com"), "no secret and no host");
  const c = fs_.addIntent({ description: "x" }) && (await m.run("vault.service.forward", { connector: "stripe", request: buildRequest(stripe, "payment_intents.list", { query: { limit: 5 } }), idem: "r1:s1" }));
  assert.equal(c.status, 200); assert.equal(body(c).data.length, 1);
  assert.equal(fs_.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(fs_.calls[0].headers["idempotency-key"], undefined, "a read carries no idempotency key");
});

test("an outward call carries the provider's idempotency header, derived from the idem key; the same act replayed under a new approval is the same customer at the provider", async t => {
  const fs_ = fakeStripe();
  const m = await mk(t, { "api.stripe.com": fs_ });
  await install(m, "stripe", stripe, KEY);
  const req = buildRequest(stripe, "customers.create", { body: { email: "sam@harlow.test", name: "Sam Rivera", metadata: { matter: "m-17" } } });
  const first = await approved(m, "stripe", req, "run7:create_customer:0", "tsk_a1");
  assert.equal(first.status, 200);
  const made = body(first);
  assert.equal(fs_.customers.size, 1);
  assert.deepEqual(fs_.customers.get(made.id).metadata, { matter: "m-17" }, "the form body is nested as Stripe reads it");
  const sent = fs_.calls[0].headers["idempotency-key"];
  assert.match(sent, /^vyre-[0-9a-f]{40}$/); assert.ok(!sent.includes("run7"), "the provider never sees a run or step id");
  // the vault's own memory is lost (a restart) and a new approval is given for the same act: the provider still sees one act
  const m2 = await mk(t, { "api.stripe.com": fs_ });
  await install(m2, "stripe", stripe, KEY);
  const again = await approved(m2, "stripe", req, "run7:create_customer:0", "tsk_a2");
  assert.equal(body(again).id, made.id, "the provider answered the first answer again");
  assert.equal(fs_.customers.size, 1, "one customer, not two");
  // a different act has a different key
  const other = await approved(m2, "stripe", buildRequest(stripe, "customers.create", { body: { email: "kim@harlow.test" } }), "run7:create_customer:1", "tsk_a3");
  assert.notEqual(body(other).id, made.id);
  assert.notEqual(fs_.calls.at(-1).headers["idempotency-key"], sent);
  // without an approval nothing leaves: the vault holds it (its own class for a change)
  const held = await m2.run("vault.service.forward", { connector: "stripe", request: req, idem: "run8:x:0" }).then(x => x, e => e);
  assert.equal(held.held, "task_1", JSON.stringify(held).slice(0, 200));
  assert.equal(fs_.customers.size, 2, "the held call did not run");
});

test("a connector with no idempotency header sends none, and an op that opts out sends none", async t => {
  const fs_ = fakeStripe();
  const m = await mk(t, { "api.stripe.com": fs_ });
  const optOut = { ...stripe, ops: { ...stripe.ops, "customers.create": { ...stripe.ops["customers.create"], idempotent: false } } };
  await install(m, "stripe", optOut, KEY);
  const r = await approved(m, "stripe", buildRequest(optOut, "customers.create", { body: { email: "p@q.test" } }), "run1:s:0", "tsk_o1");
  assert.equal(r.status, 200);
  assert.equal(fs_.calls.at(-1).headers["idempotency-key"], undefined);
  // a provider that declares none (Google's Calendar and Gmail take no idempotency header): the catalog says so and nothing is sent
  const { idempotency: _drop, ...none } = stripe;
  await install(m, "plain", none, KEY);
  assert.equal((await m.run("vault.service.catalog", {})).connectors.plain.idempotency, undefined);
  await approved(m, "plain", buildRequest(none, "customers.create", { body: { email: "r@s.test" } }), "run1:s:1", "tsk_o2");
  assert.equal(fs_.calls.at(-1).headers["idempotency-key"], undefined);
});

test("read-back through the vault: the write is checked by the paired read, and a service that answers differently is caught", async t => {
  const fs_ = fakeStripe();
  const m = await mk(t, { "api.stripe.com": fs_ });
  await install(m, "stripe", stripe, KEY);
  const wreq = { email: "sam@harlow.test", name: "Sam Rivera" };
  const w = await approved(m, "stripe", buildRequest(stripe, "customers.create", { body: wreq }), "run2:c:0", "tsk_r1");
  const done = { request: { body: wreq }, response: { json: body(w) } };
  const rb = readbackRequest(stripe, "customers.create", done);
  assert.ok(opFor(stripe, rb.request.method, rb.request.path), "the paired read is one of the connector's own ops");
  const read = await m.run("vault.service.forward", { connector: "stripe", request: rb.request, idem: "run2:c:0:rb" });
  assert.deepEqual(compareReadback(stripe, "customers.create", done, { json: body(read) }), { ok: true, mismatches: [] });
  fs_.corrupt = c => ({ ...c, email: "someone.else@harlow.test" });
  const bad = await m.run("vault.service.forward", { connector: "stripe", request: rb.request, idem: "run2:c:0:rb2" });
  const cmp = compareReadback(stripe, "customers.create", done, { json: body(bad) });
  assert.equal(cmp.ok, false); assert.equal(cmp.mismatches[0].field, "email");
});

test("a request outside the declaration is refused as any other, and a declared connector never reaches an undeclared path", async t => {
  const fs_ = fakeStripe();
  const m = await mk(t, { "api.stripe.com": fs_ });
  await install(m, "stripe", stripe, KEY);
  for (const q of [{ method: "GET", path: "/v1/balance" }, { method: "POST", path: "/v1/transfers", body: { amount: 1 } }, { method: "DELETE", path: "/v1/customers/cus_1" }]) {
    await assert.rejects(m.run("vault.service.forward", { connector: "stripe", request: q, idem: "x" }), /not open to this caller/);
  }
  assert.equal(fs_.calls.length, 0);
});

test("Gmail: a draft is prepared at once and is not outward; a send is held until a person says yes, then goes once", async t => {
  const g = fakeGoogle({ mailbox: "alex@harlow.test" });
  const m = await mk(t, { "gmail.googleapis.com": g });
  // the sign-in the vault holds is a bearer token in this test (a real one is OAuth or a service account: the vault refreshes it); the declaration's ops and classes are the same
  const gmail = { ...DECLARATIONS.gmail, auth: { type: "bearer" } };
  await install(m, "gmail", gmail, TOKEN);
  const draft = buildRequest(gmail, "drafts.create", { body: { raw: "UkZDODIyIG1lc3NhZ2U" } });
  assert.deepEqual(draft.body, { message: { raw: "UkZDODIyIG1lc3NhZ2U" } });
  const made = await m.run("vault.service.forward", { connector: "gmail", request: draft, idem: "run3:draft:0" });
  assert.equal(made.status, 200, "no approval was needed: a draft is not outward");
  assert.equal(g.drafts.length, 1); assert.equal(g.sent.length, 0);
  const send = buildRequest(gmail, "messages.send", { body: { raw: "UkZDODIyIG1lc3NhZ2U" } });
  const held = await m.run("vault.service.forward", { connector: "gmail", request: send, idem: "run3:send:0" });
  assert.ok(held.held, "a send waits for a person: " + JSON.stringify(held).slice(0, 160));
  assert.equal(g.sent.length, 0, "nothing was sent");
  const out = await approved(m, "gmail", send, "run3:send:0", "tsk_g1");
  assert.equal(out.status, 200); assert.equal(g.sent.length, 1);
  assert.equal(g.calls.at(-1).headers["idempotency-key"], undefined, "Gmail takes no idempotency key: the ledger and read-back stand in");
  // sending a draft is outward too
  const ds = buildRequest(gmail, "drafts.send", { body: { id: body(made).id } });
  assert.ok((await m.run("vault.service.forward", { connector: "gmail", request: ds, idem: "run3:ds:0" })).held);
  assert.equal(g.sent.length, 1);
});

test("one credential for Gmail and Calendar: a Flow's call reaches the host its route is on, and a path of neither is refused", async t => {
  const g = fakeGoogle({ mailbox: "alex@harlow.test" });
  const hosts = [];
  const m = await mk(t, { "gmail.googleapis.com": { handle: r => { hosts.push("gmail"); return g.handle(r); } }, "www.googleapis.com": { handle: r => { hosts.push("calendar"); return g.handle(r); } } });
  const gm = { ...DECLARATIONS.gmail, auth: { type: "bearer" } }, ca = { ...DECLARATIONS["google-calendar"], auth: { type: "bearer" } };
  await m.v.put({ name: "mail-and-calendar", kind: "api-credential", fields: { config: JSON.stringify(toCredentialConfig([gm, ca], { item: undefined })), secret: TOKEN } }, "cli");
  g.addMessage({ from: "jane@client.test", subject: "Hi" });
  g.putEvent({ id: "e1", summary: "Signing", start: { dateTime: "2026-10-08T16:00:00Z" }, end: { dateTime: "2026-10-08T17:00:00Z" } });
  const list = await m.run("vault.service.forward", { connector: "mail-and-calendar", request: buildRequest(gm, "messages.list", {}), idem: "r:1" });
  assert.equal(list.status, 200); assert.equal(body(list).messages.length, 1);
  const ev = await m.run("vault.service.forward", { connector: "mail-and-calendar", request: buildRequest(ca, "events.list", { params: { calendar: "primary" } }), idem: "r:2" });
  assert.equal(ev.status, 200); assert.equal(body(ev).items.length, 1);
  assert.deepEqual(hosts, ["gmail", "calendar"], "each call went to the host its route is on");
  const draft = await m.run("vault.service.forward", { connector: "mail-and-calendar", request: buildRequest(gm, "drafts.create", { body: { raw: "UkFX" } }), idem: "r:3" });
  assert.equal(draft.status, 200, "a draft is not held");
  assert.equal((await m.run("vault.service.forward", { connector: "mail-and-calendar", request: buildRequest(gm, "messages.send", { body: { raw: "UkFX" } }), idem: "r:4" })).held, "task_1");
  await assert.rejects(m.run("vault.service.forward", { connector: "mail-and-calendar", request: { method: "GET", path: "/drive/v3/files" }, idem: "r:5" }), /not open to this caller/);
});

test("a connector may not name one of the vault's own headers as its idempotency header", async () => {
  const { normalize } = await import("./api-request.js");
  const base = toCredentialConfig(stripe, { item: "stripe" });
  for (const h of ["Authorization", "Cookie", "Host", "X-Api-Key", "Proxy-Authorization", "Content-Type", "If-Match"]) {
    assert.throws(() => normalize({ ...base, service: { ...base.service, idempotency: { header: h } } }), /cannot be|header name/, h);
  }
  assert.deepEqual(normalize(base).service.idempotency, { header: "Idempotency-Key" });
});
