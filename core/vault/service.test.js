// @ts-check
// A Flow's "Call a service": a connector is an api-credential with `service` rules; the rules are the vault's (deny wins, default no, `*` one segment, a trailing /* the rest); the Flow
// never names a host or holds a key; an outward call after the kernel's approval runs once per idem key; only the kernel's lease module may call the two tools. Fakes: DNS, transport, clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register } from "./request.js";
import { pathMatches, routeAllowed } from "./service.js";
import { normalize } from "./api-request.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });

async function mk(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-svc-")), db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const net = { calls: /** @type {any[]} */ ([]) };
  const transport = async r => { net.calls.push({ host: r.url.hostname, path: r.url.pathname, method: r.method, headers: r.headers }); return json(200, { ok: true }); };
  const tools = new Map(), tool = (n, c, d, i, run) => tools.set(n, { run }), internal = (n, d, i, run) => tools.set(n, { run });
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, call: async () => ({ error: { code: "no_such_tool", message: "no gate" } }), said, deps: { lookup: async () => [{ address: "203.0.113.10", family: 4 }], transport, now: () => 1_800_000_000_000 } });
  const run = (n, i, caller = "module:leases") => tools.get(n).run(i, { caller });
  return { v, net, run, db };
}
const SECRET = fake("clio");
const put = (m, service, extra = {}) => m.v.put({ name: "clio", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.clio.test"], ...(service ? { service } : {}), ...extra }), secret: SECRET } }, "cli");

test("rules: * is one segment, a trailing /* is the rest, deny wins, and no rules means no", () => {
  assert.equal(pathMatches("/v4/matters/*/notes", "/v4/matters/12/notes"), true);
  assert.equal(pathMatches("/v4/matters/*/notes", "/v4/matters/12/x/notes"), false);
  assert.equal(pathMatches("/v4/matters/*", "/v4/matters/12/notes"), true);
  assert.equal(pathMatches("/v4/matters/*", "/v4/matters"), true);
  assert.equal(pathMatches("/v4/matters", "/v4/matters/1"), false);
  assert.equal(pathMatches("/v4/*", "/v4/%2e%2e/admin"), false);
  const rules = { allow: [{ method: "GET", path: "/v4/*" }, { method: "POST", path: "/v4/notes" }], deny: [{ path: "/v4/users/*" }] };
  assert.equal(routeAllowed(rules, "GET", "/v4/matters"), true);
  assert.equal(routeAllowed(rules, "GET", "/v4/users/9"), false, "deny wins");
  assert.equal(routeAllowed(rules, "DELETE", "/v4/matters"), false, "a method not listed");
  assert.equal(routeAllowed(undefined, "GET", "/v4/matters"), false);
  assert.throws(() => normalize({ auth: { type: "bearer" }, hosts: ["a.test"], service: { allow: [{ path: "/a*b" }] } }), /service rule/);
  assert.throws(() => normalize({ auth: { type: "bearer" }, hosts: ["a.test"], service: { allow: [{ path: "/a/../b" }] } }), /service rule/);
});

test("catalog lists the connectors and their rules, no host or secret; only the lease module asks", async t => {
  const m = await mk(t); await put(m, { allow: [{ method: "GET", path: "/v4/*" }], deny: [{ path: "/v4/users/*" }] });
  await m.v.put({ name: "plain", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["x.test"] }), secret: fake("p") } }, "cli");
  const c = await m.run("vault.service.catalog", {});
  assert.deepEqual(c, { connectors: { clio: { allow: [{ method: "GET", path: "/v4/*" }], deny: [{ path: "/v4/users/*" }] } } });
  assert.ok(!JSON.stringify(c).includes("api.clio.test") && !JSON.stringify(c).includes(SECRET));
  await assert.rejects(m.run("vault.service.catalog", {}, "module:flows"), /only the kernel/);
  await assert.rejects(m.run("vault.service.catalog", {}, "mcp"), /only the kernel/);
});

test("forward: an allowed read runs with the key added and the base64 body comes back; a denied path, a plain credential and a missing one are the same refusal", async t => {
  const m = await mk(t); await put(m, { allow: [{ method: "GET", path: "/v4/*" }], deny: [{ path: "/v4/users/*" }] });
  await m.v.put({ name: "plain", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["x.test"] }), secret: fake("p") } }, "cli");
  const out = await m.run("vault.service.forward", { connector: "clio", request: { method: "GET", path: "/v4/matters", query: { limit: "5" } }, idem: "run1:step1" });
  assert.equal(out.status, 200); assert.deepEqual(JSON.parse(Buffer.from(out.body, "base64").toString()), { ok: true });
  assert.equal(m.net.calls[0].host, "api.clio.test"); assert.equal(m.net.calls[0].headers.authorization, `Bearer ${SECRET}`);
  assert.ok(!JSON.stringify(out).includes(SECRET));
  const refusals = [];
  for (const q of [{ connector: "clio", request: { method: "GET", path: "/v4/users/1" } }, { connector: "clio", request: { method: "DELETE", path: "/v4/matters/1" } }, { connector: "plain", request: { method: "GET", path: "/a" } }, { connector: "nope", request: { method: "GET", path: "/a" } }]) {
    refusals.push(await m.run("vault.service.forward", q).then(() => null, e => `${e.code}: ${e.message}`));
  }
  assert.deepEqual([...new Set(refusals)], ["not_found: that request is not open to this caller"]);
  assert.equal(m.net.calls.length, 1, "nothing was sent for a refused request");
  await assert.rejects(m.run("vault.service.forward", { connector: "clio", request: { method: "GET", path: "/v4/matters" } }, "module:flows"), /only the kernel/);
  // A flow cannot choose its own host or authorization.
  await m.run("vault.service.forward", { connector: "clio", request: { method: "GET", path: "/v4/matters", headers: { authorization: "Bearer attacker" } } });
  assert.equal(m.net.calls[1].headers.authorization, `Bearer ${SECRET}`, "the Flow's own Authorization header is dropped");
});

test("forward: an approved outward call runs once per idem key, with the approval in the audit and no secret anywhere", async t => {
  const m = await mk(t); await put(m, { allow: [{ method: "POST", path: "/v4/notes" }] }, { endpoints: [{ method: "POST", path: "/v4/notes", kind: "send" }] });
  const q = { connector: "clio", request: { method: "POST", path: "/v4/notes", body: { text: "hello" } }, idem: "run9:step2", approval: "tsk_approved1" };
  const a = await m.run("vault.service.forward", q), b = await m.run("vault.service.forward", q);
  assert.equal(a.status, 200); assert.deepEqual(b, a);
  assert.equal(m.net.calls.length, 1, "the retry returned the first answer and sent nothing");
  const audit = JSON.stringify(m.db.prepare("SELECT * FROM vault_audit").all());
  assert.ok(audit.includes("released:tsk_approved1")); assert.ok(!audit.includes(SECRET));
});

test("SV-1: one canonical path form: every way of writing a path the parser or a server could read differently is refused alike, and an allowed path is sent exactly as matched", async t => {
  const m = await mk(t); await put(m, { allow: [{ method: "GET", path: "/v4/matters/*/notes" }, { method: "GET", path: "/v4/files/*" }], deny: [{ path: "/v4/users/*" }, { path: "/v4/files/secret" }] });
  const probes = [
    "/v4/matters/x\\..\\..\\users\\9/notes",           // the reviewer's probe
    "/v4/matters/x/..%2f..%2fusers/9/notes", "/v4/matters/x/..%2F..%2Fusers/9/notes", "/v4/matters/x%5c..%5cusers/9/notes", "/v4/matters/x%5C/notes",
    "/v4/us\ters/9", "/v4/users\t/9", "/v4/matters/x\n/notes", "/v4/matters/x\r/notes", "/v4/matters/x /notes", "/v4/matters/x%20/notes", "/v4/matters/x%09/notes", "/v4/matters/x%0a/notes",
    "/v4/matters/x\u0000/notes", "/v4/matters/x%00/notes", "/v4/matters/x\u007f/notes",
    "/v4/matters/x/../../users/9/notes", "/v4/matters/x/%2e%2e/%2e%2e/users/9/notes", "/v4/matters/x/.%2e/users/9/notes", "/v4/matters/x/%2E%2e/users/9",
    "/v4/matters//x/notes", "/v4//users/9", "/v4/matters/%252e%252e/users/9/notes", "/v4/matters/x%25/notes",
    "/v4/matters/x?y=/notes", "/v4/matters/x#/notes", "/v4/%75sers/9", "/v4/us%65rs/9", "/v4/%55sers/9",   // %75 is u: decoded once, the deny rule matches
    "/v4/matters/x/notes/..", "/v4/matters/./x/notes", "v4/matters/x/notes", "",
  ];
  const outcomes = [];
  for (const path of probes) outcomes.push(await m.run("vault.service.forward", { connector: "clio", request: { method: "GET", path } }).then(() => `sent ${JSON.stringify(path)}`, e => `${e.code}: ${e.message}`));
  assert.deepEqual([...new Set(outcomes)], ["not_found: that request is not open to this caller"]);
  assert.equal(m.net.calls.length, 0, "nothing reached the transport");
  // Allowed paths: decoded once, matched and sent in that form. %61 is a, so it matches the allow rule and is sent as the decoded form.
  const ok = await m.run("vault.service.forward", { connector: "clio", request: { method: "GET", path: "/v4/matters/12/notes" } });
  assert.equal(ok.status, 200); assert.equal(m.net.calls[0].path, "/v4/matters/12/notes");
  await m.run("vault.service.forward", { connector: "clio", request: { method: "GET", path: "/v4/files/%61bc" } });
  assert.equal(m.net.calls[1].path, "/v4/files/abc", "sent exactly the form that was matched");
  await assert.rejects(m.run("vault.service.forward", { connector: "clio", request: { method: "GET", path: "/v4/files/%73ecret" } }), /not open/, "a deny rule sees the decoded form");
  assert.equal(m.net.calls.length, 2);
});

test("canonicalPath is the one matcher: the lent-session route rule and the Flow connector rule both use it", async () => {
  const { canonicalPath, routeAllows, normalizeRoute } = await import("../../kernel/seal/uses.js");
  assert.equal(canonicalPath("/v4/%61bc"), "/v4/abc"); assert.equal(canonicalPath("/"), "/");
  for (const p of ["/a\\b", "/a\tb", "/a b", "/a%2fb", "/a%5cb", "/a%2eb", "/a/../b", "/a/%2e%2e/b", "/a%00", "/a%25", "/a//b", "/a?b", "x", "/a%zz"]) assert.throws(() => canonicalPath(p), /bad_input/, JSON.stringify(p));
  const def = normalizeRoute({ route: "api.clio.test", ref: "clio", allow: [{ method: "GET", path: "/v4/*" }], deny: [{ path: "/v4/users/*" }] });
  assert.equal(routeAllows(def, "GET", "/v4/matters"), true);
  for (const p of ["/v4/users/9", "/v4/%75sers/9", "/v4/x\\..\\users\\9", "/v4/x%09/y", "/v4/x/..%2fusers/9"]) assert.equal(routeAllows(def, "GET", p), false, p);
});
