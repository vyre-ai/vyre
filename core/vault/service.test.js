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

test("SV-1: a path the URL parser would rewrite (backslash, tab, line break) cannot walk around a deny rule", async t => {
  const m = await mk(t); await put(m, { allow: [{ method: "GET", path: "/v4/matters/*/notes" }], deny: [{ path: "/v4/users/*" }] });
  const same = [];
  for (const path of ["/v4/matters/x\\..\\..\\users\\9/notes", "/v4/matters/x/..%2f..%2fusers/9/notes", "/v4/us\ters/9", "/v4/users\t/9", "/v4/matters/x\n/notes", "/v4/matters/x /notes", "/v4/matters/x/../../users/9/notes"]) {
    same.push(await m.run("vault.service.forward", { connector: "clio", request: { method: "GET", path } }).then(() => `sent ${path}`, e => `${e.code}: ${e.message}`));
  }
  assert.deepEqual([...new Set(same)], ["not_found: that request is not open to this caller"]);
  assert.equal(m.net.calls.length, 0, "nothing reached the transport");
  const ok = await m.run("vault.service.forward", { connector: "clio", request: { method: "GET", path: "/v4/matters/12/notes" } });
  assert.equal(ok.status, 200);
});
