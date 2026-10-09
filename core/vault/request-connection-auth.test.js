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
  let appOrigin = () => ({ error: { code: "not_found", message: "no app" } });
  let resolve = async (/** @type {string} */ _h) => [{ address: "93.184.216.10", family: 4 }];
  const net = { calls: /** @type {any[]} */ ([]), script: /** @type {(r: any) => any} */ (() => json(200, { ok: true })) };
  const transport = async r => { net.calls.push({ path: r.url.pathname + r.url.search, headers: r.headers, method: r.method, address: r.address, host: r.url.hostname }); return net.script(r); };
  const tools = new Map();
  const tool = (name, callers, description, input, run) => tools.set(name, { run });
  const internal = (name, description, input, run) => tools.set(name, { run });
  const said = saidTools.register({ vault: v, internal });
  const api = register({ vault: v, tool, internal, call: async (/** @type {string} */ t) => (t === "appmods.origin" ? appOrigin() : { error: { code: "no_such_tool", message: "x" } }), said, deps: { lookup: async host => resolve(host), transport } });
  const ask = (input, caller = "cli") => tools.get("vault.request").run(input, { caller });
  const key = (name, fields) => v.put({ name, kind: fields.username ? "login" : "secret", fields }, "cli");
  const cred = (name, config) => v.put({ name, kind: "api-credential", fields: { config: JSON.stringify(config) } }, "cli");
  return { setApp: (/** @type {any} */ f) => { appOrigin = f; }, setResolve: (/** @type {any} */ f) => { resolve = f; }, tools, api, v, net, ask, key, cred, audit: () => v.auditTrail({ limit: 500 }).entries };
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

test("the check: the connectors module may read the check path of a Connection and nothing else, and the answer says green or the plain reason", async t => {
  const { net, ask, key, cred } = await mk(t);
  const { outcomeOf } = await import("../../records/connectors/connection.js");
  await key("ghl-pat", { value: fake("key") });
  const m = fromForm({ label: "GoHighLevel Sales", base_url: "https://services.leadconnectorhq.com", send: { how: "bearer" }, credential: { item: "ghl-pat" }, headers: { Version: "2021-07-28" }, vars: { locationId: "loc_1" }, check: { path: "/locations/{locationId}" } });
  await cred("conn-gohighlevel-sales", toConfig(m));
  const url = `https://services.leadconnectorhq.com${m.check.path}`;
  const check = async () => outcomeOf({ reply: await ask({ credential: "conn-gohighlevel-sales", method: "GET", url }, "module:connectors") });
  assert.deepEqual(await check(), { light: "green", words: "connected" });
  assert.equal(net.calls[0].path, "/locations/loc_1");
  assert.equal(net.calls[0].headers.version, "2021-07-28");
  assert.match(net.calls[0].headers.authorization, /^Bearer fixture-key-/);
  net.script = () => json(401, { message: "Invalid token" });
  assert.equal((await check()).words, "the key was refused (401)");
  net.script = () => json(404, {});
  assert.equal((await check()).words, "that id was not found (404)");
  // nothing but that one path, and nothing but a read, for the connectors module
  await assert.rejects(ask({ credential: "conn-gohighlevel-sales", method: "GET", url: "https://services.leadconnectorhq.com/contacts" }, "module:connectors"), /may only read/);
  await assert.rejects(ask({ credential: "conn-gohighlevel-sales", method: "POST", url }, "module:connectors"), /may only read/);
});

test("fetching an API description by address: a public https GET with nothing of the person's, private ranges refused at every hop, size capped, and only the connectors module may ask", async t => {
  const { api, net, setResolve, tools } = await mk(t);
  const get = (/** @type {string} */ u, /** @type {string} */ caller = "module:connectors") => tools.get("vault.fetch.public").run({ url: u }, { caller });
  net.script = () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"openapi":"3.0.0"}') });
  const ok = await get("https://docs.example.com/openapi.json");
  assert.deepEqual([ok.status, ok.body, ok.type], [200, '{"openapi":"3.0.0"}', "application/json"]);
  assert.equal(net.calls.at(-1).method, "GET"); assert.equal(net.calls.at(-1).headers.authorization, undefined); assert.equal(net.calls.at(-1).headers.cookie, undefined);
  // who may ask
  await assert.rejects(get("https://docs.example.com/x", "mcp"), /only the connectors module/);
  await assert.rejects(get("https://docs.example.com/x", "cli"), /only the connectors module/);
  // the address itself: http, a port, credentials, a private address, nothing that resolves
  await assert.rejects(get("http://docs.example.com/x"), /must be https/);
  await assert.rejects(get("https://docs.example.com:8443/x"), /https port/);
  await assert.rejects(get("https://u:p@docs.example.com/x"), /user or password/);
  setResolve(async () => [{ address: "169.254.169.254", family: 4 }]);
  await assert.rejects(get("https://metadata.example.com/x"), /private, loopback, link-local or metadata/);
  setResolve(async () => []);
  await assert.rejects(get("https://nothing.example.com/x"), /resolved to no address/);
  setResolve(async () => [{ address: "93.184.216.10", family: 4 }]);
  // a redirect is followed and checked again; one to a private address, off https, or too many, is not
  let step = 0;
  net.script = () => (step++ === 0 ? { status: 302, headers: { location: "https://raw.example.com/spec.json" }, body: Buffer.from("") } : { status: 200, headers: {}, body: Buffer.from("{}") });
  assert.equal((await get("https://docs.example.com/spec")).body, "{}");
  assert.equal(net.calls.at(-1).path, "/spec.json");
  net.script = () => ({ status: 302, headers: { location: "http://plain.example.com/x" }, body: Buffer.from("") });
  await assert.rejects(get("https://docs.example.com/spec"), /left https/);
  net.script = () => ({ status: 302, headers: { location: "https://docs.example.com/again" }, body: Buffer.from("") });
  await assert.rejects(get("https://docs.example.com/spec"), /more than three times/);
  let hop = 0;
  setResolve(async h => (hop++ === 0 ? [{ address: "93.184.216.10", family: 4 }] : [{ address: "10.0.0.5", family: 4 }]));
  net.script = () => ({ status: 302, headers: { location: "https://inside.example.com/x" }, body: Buffer.from("") });
  await assert.rejects(get("https://docs.example.com/spec"), /private, loopback/);
  setResolve(async () => [{ address: "93.184.216.10", family: 4 }]);
  // size and status
  net.script = () => ({ status: 200, headers: {}, body: Buffer.from("x"), truncated: true });
  await assert.rejects(get("https://docs.example.com/big"), /larger than 5 MB/);
  net.script = () => ({ status: 404, headers: {}, body: Buffer.from("no") });
  await assert.rejects(get("https://docs.example.com/missing"), /answered 404/);
  void api;
});

test("a Connection to an app on this machine: the vault asks the app for its origin, sends the key to exactly http://127.0.0.1:<port>, and nowhere else", async t => {
  const { net, ask, key, cred, setApp, api } = await mk(t);
  const { fromForm, toConfig } = await import("../../records/connectors/connection.js");
  await key("app-docuseal-api-token", { value: fake("tok") });
  const m = fromForm({ label: "DocuSeal", app: "docuseal", send: { how: "header", name: "X-Auth-Token" }, credential: { item: "app-docuseal-api-token" }, check: { path: "/api/templates" },
    operations: [{ name: "templates.get", method: "GET", path: "/api/templates/{id}", input: { params: { id: { type: "string", required: true } } } }, { name: "submissions.create", method: "POST", path: "/api/submissions" }] });
  await cred("conn-docuseal", toConfig(m));
  const sentinel = "https://docuseal.app.invalid";
  setApp(() => ({ data: { origin: "http://127.0.0.1:41234" } }));
  const r = await ask({ credential: "conn-docuseal", operation: "templates.get", input: { params: { id: "7" } } });
  assert.equal(r.kind, "read");
  const c = net.calls.at(-1);
  assert.equal(c.address, "127.0.0.1"); assert.equal(c.path, "/api/templates/7"); assert.match(c.headers["x-auth-token"], /^fixture-tok-/);
  assert.equal(c.host, "127.0.0.1", "the request goes to the local address, not to a name");
  // a write is held like any write, and what is approved carries the stable name, not the port of the day
  const k = async (/** @type {any} */ i) => { const p = await api.plan(await api.fromOperation({ credential: "conn-docuseal", ...i }, "conn-docuseal"), "conn-docuseal"); return p; };
  const p1 = await k({ operation: "submissions.create", input: { body: undefined } }).catch(() => null);
  const w1 = await api.plan({ credential: "conn-docuseal", method: "POST", url: `${sentinel}/api/submissions` }, "conn-docuseal");
  assert.equal(w1.kind, "send"); assert.equal(w1.href, `${sentinel}/api/submissions`);
  setApp(() => ({ data: { origin: "http://127.0.0.1:50999" } }));
  const w2 = await api.plan({ credential: "conn-docuseal", method: "POST", url: `${sentinel}/api/submissions` }, "conn-docuseal");
  assert.equal(w2.hash, w1.hash, "the app restarted on another port: the same request is the same approval");
  assert.equal(w2.url.port, "50999");
  void p1;
  // the origin is the app's to say, but only this exact shape
  for (const bad of ["http://127.0.0.1:80", "http://127.0.0.1:41234/x", "https://127.0.0.1:41234", "http://localhost:41234", "http://10.0.0.5:41234", "http://127.0.0.2:41234", "http://127.0.0.1:41234@evil.example", "http://127.0.0.1:70000"]) {
    setApp(() => ({ data: { origin: bad } }));
    await assert.rejects(ask({ credential: "conn-docuseal", method: "GET", url: `${sentinel}/api/templates` }), /will not send a key to/, bad);
  }
  // not running, or no such tool: nothing is sent
  const before = net.calls.length;
  setApp(() => ({ error: { code: "unavailable", message: "docuseal is stopped" } }));
  await assert.rejects(ask({ credential: "conn-docuseal", method: "GET", url: `${sentinel}/api/templates` }), /app is not running/);
  assert.equal(net.calls.length, before);
  // an address that is not the app's own sentinel is refused, even a local one, and a redirect is never followed
  setApp(() => ({ data: { origin: "http://127.0.0.1:41234" } }));
  await assert.rejects(ask({ credential: "conn-docuseal", method: "GET", url: "https://api.example.com/x" }), /not on this credential's allowed hosts/);
  await assert.rejects(ask({ credential: "conn-docuseal", method: "GET", url: "http://127.0.0.1:41234/api/templates" }), /must be https/);
  net.script = () => ({ status: 302, headers: { location: "http://127.0.0.1:41234/elsewhere" }, body: Buffer.from("") });
  await assert.rejects(ask({ credential: "conn-docuseal", method: "GET", url: `${sentinel}/api/templates` }), /redirect, which is not followed/);
});

test("the transport: plain http only to 127.0.0.1, with the key and Host as given, a size cap, and never to a name or another address", async () => {
  const http = await import("node:http");
  const { httpsTransport } = await import("./request.js");
  /** @type {any} */ let seen = null;
  const srv = http.createServer((req, res) => { seen = { url: req.url, headers: req.headers }; res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  try {
    const port = /** @type {any} */ (srv.address()).port;
    const r = await httpsTransport({ url: new URL(`http://127.0.0.1:${port}/api/templates?x=1`), address: "127.0.0.1", method: "GET", headers: { "x-auth-token": "k" } });
    assert.equal(r.status, 200); assert.equal(r.body.toString(), '{"ok":true}');
    assert.equal(seen.url, "/api/templates?x=1"); assert.equal(seen.headers["x-auth-token"], "k"); assert.equal(seen.headers.host, `127.0.0.1:${port}`);
    await assert.rejects(httpsTransport({ url: new URL(`http://127.0.0.1:${port}/`), address: "10.0.0.5", method: "GET", headers: {} }), /only for an app on this machine/);
    await assert.rejects(httpsTransport({ url: new URL(`http://evil.example/`), address: "93.184.216.34", method: "GET", headers: {} }), /only for an app on this machine/);
  } finally { srv.close(); }
});

test("a credential with `app` is written only in the one shape: the sentinel host, a key sign-in, a module name", () => {
  const ok = { app: "docuseal", auth: { type: "bearer", item: "k" } };
  const n = normalize({ ...ok, hosts: ["evil.example.com"] });
  assert.deepEqual(n.hosts, ["docuseal.app.invalid"], "whatever hosts are given, an app's credential has the sentinel one");
  assert.equal(n.app, "docuseal");
  assert.throws(() => normalize({ app: "Bad Name", auth: { type: "bearer", item: "k" } }), /module name/);
  assert.throws(() => normalize({ app: "docuseal", auth: { type: "oauth", client: { item: "c" }, authorize_uri: "https://a.example/a", token_uri: "https://a.example/t", scopes: [] } }), /signs in with a key/);
});
