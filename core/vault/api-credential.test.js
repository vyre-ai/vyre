// @ts-check
// The api-credential kind in a real vyred: made and changed only from a person's own surfaces
// (never a module, watcher or agent), and never handed out (reviewer M11): release, inject, an
// agent grant, reveal, copy and a one-time code all refuse it, and the sealed backup is the one
// place it travels. Nothing here reaches a network: vault.request is exercised only up to the
// point a refusal or an unknown credential stops it; the call itself is request.test.js's.
// Every value is a sample.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { open } from "../store/index.js";
import { Vault } from "./vault.js";
import { backup, inspect } from "./backup.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const CONFIG = JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.harlow.test"], endpoints: [{ method: "POST", path: "/v1/notes", kind: "send" }] });

async function daemon(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  /** @type {(tool: string, input?: any, caller?: string, meta?: any) => Promise<any>} */
  const reg = (tool, input = {}, caller = "cli", meta = {}) => d.registry.call(tool, input, caller, meta);
  return { root, d, reg };
}

test("an api-credential is made and changed only from a person's own surfaces", async t => {
  const { reg } = await daemon(t);
  const secret = fake("secret");
  const put = (o = {}, caller = "cli", meta = {}) => reg("vault.put", { name: "harlow-api", kind: "api-credential", fields: { config: CONFIG, secret }, ...o }, caller, meta);

  // Every caller that is not a person's own surface is refused, by name.
  for (const [who, caller, meta] of [
    ["a module", "module:onboard", {}], ["the watcher runtime", "module:watchers", {}], ["the mcp hub", "module:mcp", {}], ["sessions", "module:sessions", {}],
    ["mcp", "mcp", {}], ["an agent", "mcp:agent:juno", { thread: "t-1", agent: "juno" }], ["a tailnet guest", "tailnet-guest:x@y.test", {}], ["an agent's node", "tailnet:agent:juno", {}],
    ["a webhook", "hook", {}],
  ]) {
    const r = await put({}, caller, meta);
    assert.ok(r.error, `${who} (${caller}) must be refused`);
  }
  const listed = (await reg("vault.list", {}, "cli")).data;
  assert.ok(!listed.items.some(i => i.name === "harlow-api"), "nothing was made");

  // A person's own surfaces may.
  assert.equal((await put()).data.created, true);
  assert.equal((await put({ name: "harlow-api-2" }, "local")).data.created, true);
  assert.equal((await put({ name: "harlow-api-3" }, "deck")).data.created, true);
  assert.equal((await put({ name: "harlow-api-4" }, "capsule")).data.created, true);

  // Once it exists, no module changes it, replaces it or takes its name for something else.
  assert.match((await put({}, "module:onboard")).error.message, /own surfaces|was not made by/);
  assert.match((await put({ kind: "secret", fields: { value: "x" } }, "module:onboard")).error.message, /own surfaces|was not made by/);
  assert.match((await put({ kind: "secret", fields: undefined, value: "x" }, "cli")).error.message, /api-credential; delete it before/);
  // The person edits it: hosts and endpoints are theirs to change.
  const wider = JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.harlow.test", "files.harlow.test"] });
  assert.equal((await put({ fields: { config: wider, secret } })).data.created, false);

  // Never in a shared vault.
  assert.match((await put({ name: "team/harlow-api" })).error.message, /never put in a shared vault/);

  // Its config is checked the way a hub server row is.
  const bad = fields => put({ name: "harlow-bad", fields });
  assert.match((await bad({ config: "not json", secret })).error.message, /config must be JSON/);
  assert.match((await bad({ config: JSON.stringify({ auth: { type: "bearer" }, hosts: [] }), secret })).error.message, /hosts/);
  assert.match((await bad({ config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["*.googleapis.com"] }), secret })).error.message, /wildcard on a domain anyone can rent/);
  assert.match((await bad({ config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["127.0.0.1"] }), secret })).error.message, /is not a host/);
  assert.match((await bad({ config: JSON.stringify({ auth: { type: "service-account" }, hosts: ["api.harlow.test"] }), secret })).error.message, /subject/);
  assert.match((await bad({ config: CONFIG })).error.message, /its secret/);
  assert.ok((await bad({ config: CONFIG, value: secret })).data, "value is the secret's shorthand");

  // The list shows a name and a kind, never the secret or the key it names.
  const after = (await reg("vault.list", {}, "cli")).data;
  const row = after.items.find(i => i.name === "harlow-api");
  assert.equal(row.kind, "api-credential");
  assert.ok(!JSON.stringify(after).includes(secret));
});

test("an api-credential is never handed out: release, inject, an agent grant, reveal, copy and a code all refuse it", async t => {
  const { root, reg } = await daemon(t);
  const secret = fake("secret");
  assert.ok((await reg("vault.put", { name: "harlow-api", kind: "api-credential", fields: { config: CONFIG, secret } })).data);
  // The credential may be granted to a module: that is the right to call vault.request, never to read it.
  assert.equal((await reg("vault.grant", { name: "harlow-api", module: "gate" })).data.grant.status, "active");

  const refusals = [];
  const refused = async (label, r, pattern = /api-credential/) => {
    assert.ok(r.error, `${label} must be refused`);
    assert.match(r.error.message, pattern, label);
    refusals.push(r);
  };
  await refused("release", await reg("vault.release", { name: "harlow-api" }, "module:gate"));
  await refused("release of the secret field", await reg("vault.release", { name: "harlow-api", field: "secret" }, "module:gate"));
  await refused("release of the config field", await reg("vault.release", { name: "harlow-api", field: "config" }, "module:gate"));
  await refused("release for a watcher", await reg("vault.release", { name: "harlow-api", watcher: "inbox" }, "module:watchers"), /api-credential|not granted/);
  await refused("env injection into a hub server (release by module:mcp)", await reg("vault.release", { name: "harlow-api", field: "secret" }, "module:mcp"), /api-credential|not granted/);
  await refused("inject", await reg("vault.inject", { items: [{ name: "harlow-api", env: "HARLOW", field: "secret" }] }, "cli"));
  await refused("an agent grant from a person", await reg("vault.agent.grant", { agent: "kit", item: "harlow-api", origin: "https://api.harlow.test", expires: "1d" }, "cli"), /login|api-credential/);
  await refused("an agent grant from Claude", await reg("vault.agent.grant", { agent: "kit", item: "harlow-api", origin: "https://api.harlow.test", expires: "1d" }, "mcp:agent:kit", { thread: "t-1", agent: "kit" }), /login|api-credential/);
  await refused("reveal of the secret", await reg("vault.reveal", { name: "harlow-api", field: "secret" }, "cli"));
  await refused("reveal of the config", await reg("vault.reveal", { name: "harlow-api", field: "config" }, "cli"));
  await refused("reveal with no field named", await reg("vault.reveal", { name: "harlow-api" }, "cli"), /name the field|api-credential/);
  await refused("copy", await reg("vault.copy", { name: "harlow-api", field: "secret" }, "cli"), /api-credential|clipboard/);
  await refused("a one-time code", await reg("vault.totp", { name: "harlow-api" }, "cli"), /api-credential|one-time/);

  // Nothing said or logged carries it.
  assert.ok(!JSON.stringify(refusals).includes(secret));
  const audit = (await reg("vault.audit", { name: "harlow-api" }, "cli")).data.entries;
  assert.ok(!JSON.stringify(audit).includes(secret));
  assert.ok(audit.some(e => e.action === "release" && !e.ok && e.why === "api-credential"));
  assert.ok(audit.some(e => e.action === "inject" && !e.ok && e.why === "api-credential"));
  assert.ok(!audit.some(e => (e.action === "release" || e.action === "reveal" || e.action === "copy" || e.action === "inject") && e.ok), "no value ever left");

  // The sealed backup is the one place it travels, and it is sealed to the backup's passphrase.
  const file = path.join(root, "backup.vyre");
  const b = await reg("vault.backup", { file, passphrase: "correct horse battery staple sample" }, "cli");
  assert.ok(b.data.items >= 1, JSON.stringify(b));
  const blob = fs.readFileSync(file, "utf8");
  assert.ok(!blob.includes(secret) && !blob.includes("api.harlow.test"), "sealed: no plaintext");
  assert.ok(inspect(blob.trim()).items >= 1);
});

test("the class itself refuses to open an api-credential except for the sealed backup and vault.request", async t => {
  const { root, d } = await daemon(t);
  const secret = fake("secret");
  assert.ok((await d.registry.call("vault.put", { name: "harlow-api", kind: "api-credential", fields: { config: CONFIG, secret } }, "cli")).data);
  // A second Vault over the same home stands in for any code path that calls vault.fields.
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const v = new Vault({ db, dir: path.join(root, "vault"), config: { name: "test-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  const row = v.row("harlow-api");
  await assert.rejects(v.fields(row), /used only by vault\.request and is never handed out/);
  assert.equal((await v.fields(row, { sealed: true })).secret, secret, "the backup may open it");
  const c = await v.apiCredential("harlow-api");
  assert.deepEqual(c.config.hosts, ["api.harlow.test"]);
  assert.equal(c.secret, secret);
  await assert.rejects(v.apiCredential("nothing"), /no item named/);
  await assert.rejects(v.release({ name: "harlow-api" }, "module:gate"), /never handed out|not granted/);
  await assert.rejects(v.inject({ items: [{ name: "harlow-api" }] }, "cli", n => n), /never handed out/);
  // The sealed backup carries it.
  const blob = await backup(v, "correct horse battery staple sample", { params: { N: 1 << 10, r: 8, p: 1 } });
  assert.ok(inspect(blob).items >= 1);
});

test("vault.request and its Gate sender: who may call, and what stops before the network", async t => {
  const { reg } = await daemon(t);
  assert.ok((await reg("vault.put", { name: "harlow-api", kind: "api-credential", fields: { config: CONFIG, secret: fake("secret") } })).data);
  const req = { credential: "harlow-api", method: "GET", url: "https://api.harlow.test/v1/x" };
  // Not for a guest, or an agent's node.
  assert.equal((await reg("vault.request", req, "tailnet-guest:x@y.test")).error.code, "denied");
  assert.equal((await reg("vault.request", req, "tailnet:agent:juno")).error.code, "denied");
  // A module needs its own grant; a watcher's is its own.
  assert.match((await reg("vault.request", req, "module:watchers")).error.message, /not granted to watchers for vault\.request/);
  assert.match((await reg("vault.request", { ...req, watcher: "inbox" }, "module:watchers")).error.message, /not granted to watchers\/inbox/);
  // An unknown credential, a plain secret, and a host the credential does not name.
  assert.match((await reg("vault.request", { ...req, credential: "nothing" }, "cli")).error.message, /no item named/);
  assert.ok((await reg("vault.put", { name: "plain", kind: "secret", value: "sample-value-1234" })).data);
  assert.match((await reg("vault.request", { ...req, credential: "plain" }, "cli")).error.message, /not an api-credential/);
  assert.match((await reg("vault.request", { ...req, url: "https://evil.test/v1/x" }, "cli")).error.message, /not on this credential's allowed hosts/);
  assert.match((await reg("vault.request", { ...req, url: "https://api.harlow.test/v1/x", headers: { Authorization: "Bearer x" } }, "cli")).error.message, /set by the credential/);
  // The Gate's sender is internal, and only the Gate runs it.
  for (const who of ["cli", "local", "mcp", "tailnet-guest:x@y.test", "hook"]) assert.equal((await reg("vault.api.send", { id: "abc" }, who)).error.code, "no_such_tool", who);
  assert.match((await reg("vault.api.send", { id: "abc" }, "module:sessions")).error.message, /only the Gate sends/);
  // The sender is offered to the Gate under a name in the vault's own namespace.
  // (Modules start in dependency order and neither needs the other, so the offer retries until the Gate is there.)
  let senders = [];
  for (let i = 0; i < 40 && !senders.some(s => s.name === "vault-api"); i++) {
    senders = (await reg("gate.senders", {}, "cli")).data;
    if (!senders.some(s => s.name === "vault-api")) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(senders.some(s => s.name === "vault-api" && s.module === "vault" && s.kinds.includes("spend")), JSON.stringify(senders));
});
