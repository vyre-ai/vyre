// @ts-check
// The three ways a person-made Connection can send its key that the vault did not have: basic, a query parameter, and fixed headers vyred adds. Fakes only: a fake DNS lookup and a fake transport
// that records what would have been sent. What these prove: the key is added by the vault and never reaches a result or the audit; a caller cannot override a fixed header or the key; a basic
// credential reads username and password from the item; and the fixed headers refuse the names that authenticate.
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
import { normalize } from "./api-request.js";
import { fromForm, toConfig } from "../../records/connectors/connection.js";
import { defineConnector } from "../../records/connectors/format.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });

async function mk(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-conn-auth-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const net = { calls: /** @type {any[]} */ ([]), script: /** @type {(r: any) => any} */ (() => json(200, { ok: true })) };
  const transport = async r => { net.calls.push({ path: r.url.pathname + r.url.search, headers: r.headers, method: r.method }); return net.script(r); };
  const tools = new Map();
  const tool = (name, callers, description, input, run) => tools.set(name, { run });
  const internal = (name, description, input, run) => tools.set(name, { run });
  const said = saidTools.register({ vault: v, internal });
  const api = register({ vault: v, tool, internal, call: async () => ({ error: { code: "no_such_tool", message: "x" } }), said, deps: { lookup: async () => [{ address: "203.0.113.10", family: 4 }], transport } });
  const ask = (input, caller = "cli") => tools.get("vault.request").run(input, { caller });
  const key = (name, fields) => v.put({ name, kind: fields.username ? "login" : "secret", fields }, "cli");
  const cred = (name, config) => v.put({ name, kind: "api-credential", fields: { config: JSON.stringify(config) } }, "cli");
  return { api, v, net, ask, key, cred, audit: () => v.auditTrail({ limit: 500 }).entries };
}
const BASE = { hosts: ["api.example.com"], endpoints: [{ method: "GET", path: "/*", kind: "read" }] };

test("basic: the item's username and password make the header, and nothing shows the key", async t => {
  const { net, ask, key, cred, audit } = await mk(t);
  const pw = fake("pw");
  await key("crm-login", { username: "alex", password: pw });
  await cred("conn-crm", { ...BASE, auth: { type: "basic", item: "crm-login" } });
  net.script = () => json(200, { echo: Buffer.from(`alex:${pw}`).toString("base64"), pw });
  const r = await ask({ credential: "conn-crm", method: "GET", url: "https://api.example.com/me" });
  assert.equal(net.calls[0].headers.authorization, `Basic ${Buffer.from(`alex:${pw}`).toString("base64")}`);
  assert.ok(!JSON.stringify(r).includes(pw) && !JSON.stringify(r).includes(Buffer.from(`alex:${pw}`).toString("base64")), "scrubbed");
  assert.ok(!JSON.stringify(audit()).includes(pw));
});

test("query: the key goes in the named parameter on every call, never in what is approved or audited", async t => {
  const { net, ask, key, cred, audit } = await mk(t);
  const k = fake("key");
  await key("crm-key", { value: k });
  await cred("conn-crm", { ...BASE, auth: { type: "api-key", item: "crm-key", in: "query", param: "api_key" } });
  net.script = () => json(200, { url: `x?api_key=${k}` });
  const r = await ask({ credential: "conn-crm", method: "GET", url: "https://api.example.com/me", query: { page: 2 } });
  const q = new URLSearchParams(net.calls[0].path.split("?")[1]);
  assert.equal(q.get("api_key"), k); assert.equal(q.get("page"), "2");
  assert.ok(!JSON.stringify(r).includes(k), "scrubbed from the answer");
  assert.ok(!JSON.stringify(audit()).includes(k), "not in the audit");
  // a caller who names the parameter itself cannot change which key is sent
  await ask({ credential: "conn-crm", method: "GET", url: "https://api.example.com/me?api_key=attacker" });
  assert.equal(new URLSearchParams(net.calls[1].path.split("?")[1]).get("api_key"), k);
});

test("fixed headers are added by the vault and a caller cannot override them", async t => {
  const { net, ask, key, cred } = await mk(t);
  await key("crm-key", { value: fake("key") });
  await cred("conn-crm", { ...BASE, auth: { type: "bearer", item: "crm-key" }, headers: { version: "2021-07-28", "x-location": "loc_1" } });
  await ask({ credential: "conn-crm", method: "GET", url: "https://api.example.com/me" });
  assert.equal(net.calls[0].headers.version, "2021-07-28");
  assert.equal(net.calls[0].headers["x-location"], "loc_1");
  await ask({ credential: "conn-crm", method: "GET", url: "https://api.example.com/me", headers: { version: "1999", "x-location": "loc_other" } });
  assert.equal(net.calls[1].headers.version, "2021-07-28", "the person's fixed value wins");
  assert.equal(net.calls[1].headers["x-location"], "loc_1");
});

test("a fixed header cannot be one that authenticates or frames the request, and a query key names its parameter", () => {
  const ok = { ...BASE, auth: { type: "bearer", item: "k" } };
  for (const bad of ["authorization", "Cookie", "host", "x-api-key", "content-length", "x-vyre-run", "x-auth-token", "proxy-authorization"]) assert.throws(() => normalize({ ...ok, headers: { [bad]: "x" } }), /authenticates or frames/, bad);
  assert.throws(() => normalize({ ...ok, headers: { version: "a\nb" } }), /single-line/);
  assert.throws(() => normalize({ ...ok, auth: { type: "api-key", item: "k", in: "query" } }), /names its parameter/);
  assert.throws(() => normalize({ ...ok, auth: { type: "bearer", item: "k", in: "query", param: "p" } }), /for an api-key/);
  assert.throws(() => normalize({ ...ok, auth: { type: "basic", item: "k", header: "x" } }), /no header or format/);
  assert.deepEqual(normalize({ ...ok, headers: { Version: "1" } }).headers, { version: "1" });
});

test("a Connection's operation is built into the request a caller could have written, and judged as that request", async t => {
  const { api, net, ask, key, cred } = await mk(t);
  await key("ghl-pat", { value: fake("key") });
  const m = fromForm({ label: "CRM", base_url: "https://api.example.com", send: { how: "bearer" }, credential: { item: "ghl-pat" }, headers: { Version: "2021-07-28" }, check: { path: "/me" } });
  const decl = defineConnector({ ...m.declaration, ops: { ...m.declaration.ops,
    "contacts.get": { method: "GET", path: "/contacts/{id}", kind: "read", input: { params: { id: { type: "string", required: true } }, query: { fields: { type: "string" } } } },
    "contacts.search": { method: "POST", path: "/contacts/search", kind: "read", relabeled: true, input: { body: { query: { type: "string", required: true } } } },
    "contacts.create": { method: "POST", path: "/contacts", kind: "change", input: { body: { name: { type: "string", required: true } } } } } });
  await cred("conn-crm", toConfig({ ...m, declaration: decl }));
  // a read operation runs at once, the path is filled and encoded, the fixed header and the key are the vault's
  const r = await ask({ credential: "conn-crm", operation: "contacts.get", input: { params: { id: "a b" }, query: { fields: "name" } } });
  assert.equal(r.kind, "read");
  assert.equal(net.calls[0].path, "/contacts/a%20b?fields=name");
  assert.equal(net.calls[0].headers.version, "2021-07-28");
  // the relabeled search is a read (it runs at once); the create is held; the generic request is judged by its method
  assert.equal((await ask({ credential: "conn-crm", operation: "contacts.search", input: { body: { query: "dana" } } })).kind, "read");
  assert.equal(net.calls[1].method, "POST");
  const kindOf = async (/** @type {any} */ input) => (await api.plan(await api.fromOperation({ credential: "conn-crm", ...input }, "conn-crm"), "conn-crm")).kind;
  assert.equal(await kindOf({ operation: "contacts.create", input: { body: { name: "Dana" } } }), "send");
  assert.equal(await kindOf({ operation: "request", input: { method: "GET", path: "/anything" } }), "read");
  assert.equal(await kindOf({ operation: "request", input: { method: "POST", path: "/anything", body: { a: 1 } } }), "send");
  assert.equal(await kindOf({ operation: "request", input: { method: "DELETE", path: "/anything/1" } }), "delete");
  // an id that would climb out of its segment is encoded, and the vault refuses an encoded slash
  await assert.rejects(ask({ credential: "conn-crm", operation: "contacts.get", input: { params: { id: "a/../b" } } }), /encoded slash/);
  // refusals: an undeclared input, a missing one, an unknown operation, a path that is not one, a credential that is not a Connection
  await assert.rejects(ask({ credential: "conn-crm", operation: "contacts.get", input: { params: { id: "1" }, query: { sneak: "x" } } }), /not part of this/);
  await assert.rejects(ask({ credential: "conn-crm", operation: "contacts.get", input: {} }), /needed/);
  await assert.rejects(ask({ credential: "conn-crm", operation: "nope.go" }), /no operation nope\.go/);
  await assert.rejects(ask({ credential: "conn-crm", operation: "request", input: { method: "GET", path: "https://evil.example/x" } }), /path from the root/);
  await assert.rejects(ask({ credential: "conn-crm", operation: "request", input: { method: "GET", path: "/a?x=1" } }), /path from the root/);
  await key("plain", { value: fake("k2") });
  await cred("plain-cred", { hosts: ["api.example.com"], auth: { type: "bearer", item: "plain" } });
  await assert.rejects(ask({ credential: "plain-cred", operation: "request", input: { method: "GET", path: "/x" } }), /not a Connection/);
  // a request with neither a url nor an operation says so
  await assert.rejects(ask({ credential: "conn-crm" }), /names its method and url, or an operation/);
});
