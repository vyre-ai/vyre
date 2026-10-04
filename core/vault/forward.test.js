// @ts-check
// Credentialed calls from a lent computer run at the home, through vault.request's own path: the three credential kinds a real firm needs (a plain key, an OAuth sign-in that
// refreshes, a Google service account with domain-wide delegation for named mailboxes), route allow and deny lists with a default of no, outward calls held, plain size limits,
// and no key, token or header value in anything that goes back to the device or into the audit. Fakes only: DNS, transport and clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register } from "./request.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { startSealer } from "../../kernel/seal/client.js";
import { person } from "../../kernel/seal/testing.js";
import { leasedForward, normalizeRoute, routeAllows } from "../../kernel/seal/uses.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body, extra = {}) => ({ status, headers: { "content-type": "application/json", ...extra }, body: Buffer.from(JSON.stringify(body)) });
const SESSION = "sess1";
const TOKEN_URI = "https://login.clio.test/oauth/token", GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

async function mk(t, { gate = null } = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-fwd-")), db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let clock = 1_800_000_000_000;
  const net = { calls: /** @type {any[]} */ ([]), script: /** @type {(r: any) => any} */ (() => json(200, { ok: true })) };
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  const transport = async r => { net.calls.push({ host: r.url.hostname, path: r.url.pathname + r.url.search, method: r.method, headers: r.headers, body: r.body }); return net.script(r); };
  const tools = new Map(), tool = (name, callers, d, i, run) => tools.set(name, { run }), internal = (name, d, i, run) => tools.set(name, { run });
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, call: gate ?? (async () => ({ error: { code: "no_such_tool", message: "no gate" } })), said, deps: { lookup, transport, now: () => clock } });
  const run = (name, input, caller = "cli") => tools.get(name).run(input, { caller });
  // The kernel side: the REAL sealing process holds the lease and a REAL kernel chain stands for the person (kernel/core/chain.js); the route check is the real one and `forward` is the vault's
  // internal tool, callable only as kernel:leases. SHIM(gateway-forward): `leasedForward` is composed here because the kernel's gateway has no `leases.forward` yet (it still has `use`, which returns
  // a credential); SHIM(authorize): no kernel `authorize` check on vault.read / vault.call is run in this composition.
  const sealer = startSealer({ dir: fs.mkdtempSync(path.join(SCRATCH, "vyre-fwdseal-")), timeoutMs: 8000, dev: true }); t.after(() => sealer.close());
  const who = person("per_alex"), lease = await sealer.lease.issue({ chain: who, device: "dev_mac", allowed: true });
  const leases = { revoke: () => sealer.lease.revoke({ chain: who, member: "per_alex", device: "dev_mac" }) };
  const bound = new Map([[SESSION, lease.id]]), routes = new Map();
  const audits = () => /** @type {any[]} */ (db.prepare("SELECT * FROM vault_audit").all());
  const go = (chain = who) => leasedForward({ chain, leaseOf: s => bound.get(s) ?? null, check: ({ id }) => sealer.lease.check({ chain: who, id }), routesOf: s => routes.get(s) ?? [],
    forward: async i => { const r = await run("vault.forward", { credential: i.ref, method: i.method, url: `https://${i.route}${i.path}`, query: i.query, headers: i.headers, allow_headers: i.allow_headers, body: i.body, session: i.session }, "kernel:leases"); return r; }, emit: () => {} });
  const call = (o, session = SESSION) => go()({ session, route: o.route, method: o.method ?? "GET", path: o.path, query: o.query, headers: o.headers, body: o.body });
  const wire = async (o, session) => { const r = await call(o, session); return r.body === undefined || r.held ? r : { ...r, body: Buffer.from(r.body, "base64") }; };
  return { v, net, run, tick: ms => { clock += ms; }, leases, lease, bound, routes, call: wire, audits, db };
}
const everything = m => JSON.stringify([m.audits()]);

async function addKey(m, S) { await m.v.put({ name: "dropsign", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.hellosign.test"], endpoints: [{ method: "POST", path: "/v3/signature_request/send", kind: "send" }] }), secret: S } }, "cli"); }

test("a plain API key: the read runs at the home with the key added, the device gets the response only, and nothing leaks into it or the audit", async t => {
  const m = await mk(t), S = fake("dropsign"); await addKey(m, S);
  m.routes.set(SESSION, [normalizeRoute({ route: "api.hellosign.test", ref: "dropsign", allow: [{ method: "GET", path: "/v3/*" }], headers: ["x-matter-id"] })]);
  m.net.script = r => json(200, { requests: [1, 2] }, { "set-cookie": "sid=abc", "x-request-id": "r1" });
  const out = await m.call({ route: "api.hellosign.test", path: "/v3/signature_request/list", query: { page: "1" }, headers: { accept: "application/json", authorization: "Bearer attacker", "x-api-key": "attacker", "x-matter-id": "m42" } });
  assert.equal(out.status, 200); assert.deepEqual(JSON.parse(out.body.toString()), JSON.parse('{"requests":[1,2]}')); assert.equal(out.headers["set-cookie"], undefined);
  const c = m.net.calls[0]; assert.equal(c.headers.authorization, `Bearer ${S}`, "the home added the key"); assert.notEqual(c.headers["x-api-key"], "attacker"); assert.equal(c.headers["x-matter-id"], "m42"); assert.equal(c.path.includes("page=1"), true);
  assert.equal(JSON.stringify(out).includes(S), false, "no key in what goes back"); assert.equal(everything(m).includes(S), false, "no key in the audit");
  // An upstream that echoes the Authorization header back is scrubbed, as bytes it is withheld.
  m.net.script = r => json(200, { echo: r.headers.authorization }); const echoed = await m.call({ route: "api.hellosign.test", path: "/v3/me" });
  assert.equal(echoed.body.toString().includes(S), false);
  m.net.script = r => ({ status: 200, headers: { "content-type": "application/pdf" }, body: Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.from(r.headers.authorization), Buffer.from(" end")]) });
  await assert.rejects(m.call({ route: "api.hellosign.test", path: "/v3/file" }), /withheld/);
  m.net.script = () => ({ status: 200, headers: { "content-type": "application/pdf" }, body: Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.from([0, 1, 2, 3])]) });
  const pdf = await m.call({ route: "api.hellosign.test", path: "/v3/file" }); assert.equal(pdf.body.subarray(0, 4).toString(), "%PDF", "a file comes back as bytes");
});

test("an OAuth sign-in that expires: refreshed at the home with the sealed refresh token, the rotation sealed before the call goes on, and no token goes back", async t => {
  const m = await mk(t); await m.v.put({ name: "clio-app", kind: "env-set", fields: { client_id: "client-abc-123", client_secret: fake("client") } }, "cli");
  await m.v.put({ name: "clio", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "oauth", client: { item: "clio-app" }, authorize_uri: "https://login.clio.test/oauth/authorize", token_uri: TOKEN_URI, scopes: ["openid"] }, hosts: ["app.clio.test"] }) } }, "cli");
  const first = { access_token: fake("at1"), refresh_token: fake("rt1"), expires_in: 3600, token_uri: TOKEN_URI };
  await m.run("vault.credential.tokens", { name: "clio", tokens: first }, "module:connectors");
  m.routes.set(SESSION, [normalizeRoute({ route: "app.clio.test", ref: "clio", allow: [{ method: "GET", path: "/api/v4/*" }] })]);
  let rt2 = fake("rt2"), at2 = fake("at2");
  m.net.script = r => (r.url.hostname === "login.clio.test" ? json(200, { access_token: at2, refresh_token: rt2, expires_in: 3600 }) : json(200, { matters: [] }));
  await m.call({ route: "app.clio.test", path: "/api/v4/matters" }); assert.equal(m.net.calls.at(-1).headers.authorization, `Bearer ${first.access_token}`, "the stored token while it is good");
  m.tick(3_700_000); const out = await m.call({ route: "app.clio.test", path: "/api/v4/matters" });
  assert.ok(m.net.calls.some(c => c.host === "login.clio.test"), "refreshed at the token endpoint"); assert.equal(m.net.calls.at(-1).headers.authorization, `Bearer ${at2}`);
  const sealed = JSON.parse((await m.v.apiCredential("clio")).secret); assert.equal(sealed.refresh_token, rt2, "the rotated refresh token is sealed in the vault");
  for (const s of [first.access_token, first.refresh_token, at2, rt2]) { assert.equal(JSON.stringify(out).includes(s), false); assert.equal(everything(m).includes(s), false); }
});

test("a Google service account with delegation: the key stays in the vault, the subject and scopes are the credential's, and a route cannot reach a mailbox it does not name", async t => {
  const m = await mk(t), { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }), pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await m.v.put({ name: "sa-key", kind: "env-set", fields: { json: JSON.stringify({ client_email: "intake@harlow-proj.iam.test", private_key: pem, token_uri: GOOGLE_TOKEN }) } }, "cli");
  for (const [name, sub] of [["gmail-a", "a@harlow.test"], ["gmail-b", "b@harlow.test"]]) await m.v.put({ name, kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "service-account", item: "sa-key", field: "json", subject: sub, scopes: ["https://www.googleapis.com/auth/gmail.readonly"] }, hosts: ["gmail.harlow.test"] }) } }, "cli");
  const subs = [];
  m.net.script = r => { if (r.url.hostname === "oauth2.googleapis.com") { const claims = JSON.parse(Buffer.from(String(r.body).match(/assertion=([^&]+)/)[1].split(".")[1], "base64url").toString()); subs.push(claims.sub); return json(200, { access_token: `tok-${claims.sub}`, expires_in: 3600 }); } return json(200, { messages: [] }); };
  // The session's definition maps ONE mailbox: gmail-a, read-only under users/me, never settings.
  m.routes.set(SESSION, [normalizeRoute({ route: "gmail.harlow.test", ref: "gmail-a", allow: [{ method: "GET", path: "/gmail/v1/users/me/*" }], deny: [{ path: "/gmail/v1/users/me/settings/*" }] })]);
  const ok = await m.call({ route: "gmail.harlow.test", path: "/gmail/v1/users/me/messages" }); assert.equal(ok.status, 200);
  assert.deepEqual(subs, ["a@harlow.test"]); assert.equal(m.net.calls.at(-1).headers.authorization, "Bearer tok-a@harlow.test");
  for (const [why, o] of [["another mailbox's path", { path: "/gmail/v1/users/b@harlow.test/messages" }], ["a denied path", { path: "/gmail/v1/users/me/settings/filters" }], ["a write", { method: "POST", path: "/gmail/v1/users/me/messages/send" }], ["a dot segment", { path: "/gmail/v1/users/me/../b@harlow.test/messages" }], ["an encoded dot", { path: "/gmail/v1/users/me/%2e%2e/x" }], ["another host", { route: "evil.test", path: "/gmail/v1/users/me/messages" }]])
    await assert.rejects(m.call({ route: "gmail.harlow.test", ...o }), { code: "not_found" }, why);
  assert.deepEqual(subs, ["a@harlow.test"], "no token was ever minted for the other mailbox");
  // gmail-b exists in the vault but the session's route does not name it: no way to ask for it, however the request is dressed.
  await assert.rejects(m.call({ route: "gmail.harlow.test", path: "/gmail/v1/users/me/messages", headers: { "x-goog-authuser": "b@harlow.test" } }).then(() => m.net.calls.at(-1)).then(c => { assert.equal(c.headers.authorization, "Bearer tok-a@harlow.test"); throw new Error("same mailbox"); }), /same mailbox/);
  for (const s of [pem.slice(40, 80), "BEGIN PRIVATE KEY", "tok-a@harlow.test"]) { assert.equal(JSON.stringify(ok).includes(s), false); assert.equal(everything(m).includes(s), false); }
});

test("an outward call is held for the ask-first task whoever asked, and runs nothing until a person approves", async t => {
  const gate = async (tool, input) => (tool === "gate.offer" ? { data: {} } : tool === "gate.request" ? { data: { id: "task_1", state: "held", message: "waiting for a person" } } : { error: { code: "no_such_tool", message: tool } });
  const m = await mk(t, { gate }), S = fake("dropsign"); await addKey(m, S);
  m.routes.set(SESSION, [normalizeRoute({ route: "api.hellosign.test", ref: "dropsign", allow: [{ method: "GET", path: "/v3/*" }, { method: "POST", path: "/v3/signature_request/send" }] })]);
  const before = m.net.calls.length, out = await m.call({ route: "api.hellosign.test", method: "POST", path: "/v3/signature_request/send", headers: { "content-type": "application/json" }, body: { title: "Retainer", signers: [{ email_address: "jane@harlow.test" }] } });
  assert.equal(out.held, "task_1"); assert.equal(m.net.calls.length, before, "nothing went out"); assert.equal(JSON.stringify(out).includes(S), false);
  await assert.rejects(m.call({ route: "api.hellosign.test", method: "DELETE", path: "/v3/signature_request/cancel/abc" }), { code: "not_found" }, "not on the route's list: refused, not held");
});

test("limits are plain: a request body over 1 MB, a binary upload and a response over 2 MB are refused with a clear error, a lease is required, and only the kernel may forward", async t => {
  const m = await mk(t), S = fake("dropsign"); await addKey(m, S);
  m.routes.set(SESSION, [normalizeRoute({ route: "api.hellosign.test", ref: "dropsign", allow: [{ method: "GET", path: "/v3/*" }, { method: "POST", path: "/v3/up" }] })]);
  await assert.rejects(m.call({ route: "api.hellosign.test", method: "POST", path: "/v3/up", headers: { "content-type": "text/plain" }, body: "x".repeat(1_000_001) }), /larger than 1 MB/);
  await assert.rejects(m.call({ route: "api.hellosign.test", method: "POST", path: "/v3/up", body: 12345 }), /binary or multipart/);
  m.net.script = () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(10), truncated: true });
  await assert.rejects(m.call({ route: "api.hellosign.test", path: "/v3/big" }), /larger than 2 MB/);
  await assert.rejects(m.call({ route: "api.hellosign.test", path: "/v3/x" }, "no-such-session"), { code: "no_lease" });
  for (const who of ["cli", "mcp", "module:connectors", "runner:sess1"]) await assert.rejects(m.run("vault.forward", { credential: "dropsign", method: "GET", url: "https://api.hellosign.test/v3/x", session: SESSION }, who), /only the kernel/, who);
  // A revoked lease ends it at once.
  await m.leases.revoke(); await assert.rejects(m.call({ route: "api.hellosign.test", path: "/v3/x" }), { code: "no_lease" });
});

test("routeAllows: exact pairs, prefix paths, deny wins, the default is no, and shorthand still works", () => {
  const r = normalizeRoute({ route: "A.test", ref: "c", allow: [{ method: "get", path: "/a/*" }, { method: "POST", path: "/a/send" }], deny: [{ path: "/a/private/*" }, { method: "POST", path: "/a/send" }] });
  assert.equal(r.route, "a.test"); assert.equal(routeAllows(r, "GET", "/a/x?y=1"), true); assert.equal(routeAllows(r, "GET", "/a"), true); assert.equal(routeAllows(r, "GET", "/ab"), false);
  assert.equal(routeAllows(r, "GET", "/a/private/k"), false, "deny wins"); assert.equal(routeAllows(r, "POST", "/a/send"), false, "deny wins over allow"); assert.equal(routeAllows(r, "DELETE", "/a/x"), false);
  assert.equal(routeAllows(normalizeRoute({ route: "a.test", ref: "c" }), "GET", "/a"), false, "no paths, no access");
  const old = normalizeRoute({ route: "a.test", ref: "c", paths: ["/v1/*", "/me"] }); assert.equal(routeAllows(old, "GET", "/v1/x"), true); assert.equal(routeAllows(old, "HEAD", "/me"), true); assert.equal(routeAllows(old, "POST", "/me"), false);
  assert.throws(() => normalizeRoute({ route: "a.test", ref: "c", allow: [{ method: "GET", path: "/a*b" }] }), { code: "bad_input" });
});

test("FW-1: request headers are an allow-list: a safe default plus the route's own named headers, and the rewrite, override, forwarding and credential families never pass, whatever the route says", async t => {
  const m = await mk(t), S = fake("dropsign"); await addKey(m, S);
  const probe = { accept: "application/json", "content-type": "application/json", "if-none-match": "abc", "x-matter-id": "m42", "x-custom": "1",
    "x-http-method-override": "DELETE", "x-http-method": "DELETE", "x-method-override": "DELETE", "x-original-url": "/v3/admin", "x-rewrite-url": "/v3/admin", "x-forwarded-host": "evil.test", "x-forwarded-for": "1.2.3.4",
    "x-real-ip": "1.2.3.4", "x-host": "evil.test", "x-goog-iam-authorization-token": "tok", "x-amz-security-token": "tok", "x-ms-authorization-auxiliary": "tok", authorization: "Bearer attacker", cookie: "sid=1",
    host: "evil.test", "x-api-key": "attacker", "proxy-authorization": "x", "sec-fetch-mode": "cors", "x-vyre-token": "t", "x-access-token": "t", "x-oauth-token": "t", "x-session-id": "s", "x-goog-api-key": "k", forwarded: "for=1.2.3.4", "content-length": "9", "transfer-encoding": "chunked" };
  const seen = async routeHeaders => { m.routes.set(SESSION, [normalizeRoute({ route: "api.hellosign.test", ref: "dropsign", allow: [{ method: "GET", path: "/v3/*" }], ...(routeHeaders ? { headers: routeHeaders } : {}) })]); m.net.calls.length = 0; await m.call({ route: "api.hellosign.test", path: "/v3/x", headers: probe }); const h = { ...m.net.calls[0].headers }; delete h.authorization; delete h.host; return Object.keys(h).filter(k => !["accept", "content-type", "if-none-match"].includes(k)).sort(); };
  assert.deepEqual(await seen(null), ["content-type"].filter(() => false), "by default only the safe set reaches the vendor (the credential's own authorization is the home's)");
  assert.equal(m.net.calls[0].headers.authorization, `Bearer ${S}`, "the home added the key, not the program");
  assert.deepEqual(await seen(["x-matter-id"]), ["x-matter-id"], "a header the route names passes");
  const naming = ["x-matter-id", "x-http-method-override", "x-original-url", "x-forwarded-host", "x-amz-security-token", "authorization", "cookie", "x-rewrite-url", "x-goog-iam-authorization-token", "x-access-token", "x-oauth-token", "x-session-id", "x-goog-api-key"];
  assert.deepEqual(await seen(naming), ["x-matter-id"], "naming a dangerous header on the route does not let it through");
  assert.throws(() => normalizeRoute({ route: "a.test", ref: "c", headers: ["bad name"] }), { code: "bad_input" });
});

test("FW-3: the route, its limits, its Drive lists and its header names come from the home's record only; what the program adds to the request is ignored", async t => {
  const m = await mk(t), S = fake("dropsign"); await addKey(m, S);
  m.routes.set(SESSION, [normalizeRoute({ route: "api.hellosign.test", ref: "dropsign", allow: [{ method: "GET", path: "/v3/*" }] })]);
  await m.v.put({ name: "other", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.hellosign.test"] }), secret: fake("other") } }, "cli");
  m.net.calls.length = 0;
  await m.call({ route: "api.hellosign.test", path: "/v3/x", ref: "other", credential: "other", allow_headers: ["x-anything"], headers: { "x-anything": "1" }, limits: { maxBytes: 1e9 }, drive: { read: ["*"], write: ["*"] }, allow: [{ method: "DELETE", path: "/*" }] });
  assert.equal(m.net.calls.length, 1); assert.equal(m.net.calls[0].headers.authorization, `Bearer ${S}`, "the route's own credential, not the one the program named"); assert.equal(m.net.calls[0].headers["x-anything"], undefined);
  await assert.rejects(m.call({ route: "api.hellosign.test", method: "DELETE", path: "/v3/x", allow: [{ method: "DELETE", path: "/*" }] }), { code: "not_found" }, "a program cannot widen the route");
});
