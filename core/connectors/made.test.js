// @ts-check
// Connections a person made: the row, the derived credential, the check and the light, against a fake vault (the real vault is exercised by the daemon test and request-connection-auth.test.js).
// What these prove: saving writes one derived credential whose config carries no key; a missing key item stops the save and leaves nothing behind; a check says its answer in plain words and keeps
// the light; a credential changed behind the record's back shows out of step and does not run; rebuilding fixes it; deleting removes both.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../lib/connectors/connect.js";
import { madeConnections } from "./made.js";

function world() {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  let clock = 1000;
  /** @type {Map<string, any>} */ const items = new Map([["ghl-pat", { name: "ghl-pat", kind: "secret", updated: 1 }]]);
  const calls = /** @type {any[]} */ ([]);
  let reply = /** @type {any} */ ({ data: { status: 200, body: {} } });
  const call = async (tool, input, opts) => {
    calls.push({ tool, input, opts });
    if (tool === "vault.list") return { data: { items: [...items.values()] } };
    if (tool === "vault.put") { items.set(input.name, { name: input.name, kind: input.kind, updated: ++clock, fields: input.fields }); return { data: {} }; }
    if (tool === "vault.delete") { items.delete(input.name); return { data: {} }; }
    if (tool === "vault.request") return typeof reply === "function" ? reply(input) : reply;
    if (tool.startsWith("vault.connections.")) return { data: {} };
    return { error: { code: "no_such_tool", message: tool } };
  };
  const events = /** @type {string[]} */ ([]);
  const m = madeConnections({ db, call, now: () => ++clock, emit: t => events.push(t) });
  return { m, db, items, calls, events, setReply: r => { reply = r; } };
}
const form = (o = {}) => ({ label: "GoHighLevel Sales", base_url: "https://services.leadconnectorhq.com", send: { how: "bearer" }, credential: { item: "ghl-pat" }, headers: { Version: "2021-07-28" },
  vars: { locationId: "loc_1" }, check: { path: "/locations/{locationId}" }, ...o });

test("saving writes the row and one derived credential, with no key in it", async () => {
  const w = world();
  const r = await w.m.save(form(), { as: "deck" });
  assert.deepEqual(r, { id: "gohighlevel-sales", credential: "conn-gohighlevel-sales" });
  const put = w.calls.find(c => c.tool === "vault.put");
  assert.equal(put.opts.as, "deck", "written as the person");
  assert.equal(put.input.kind, "api-credential");
  const cfg = JSON.parse(put.input.fields.config);
  assert.deepEqual(cfg.hosts, ["services.leadconnectorhq.com"]);
  assert.deepEqual(cfg.auth, { type: "bearer", item: "ghl-pat" });
  assert.equal(put.input.fields.secret, undefined, "the key stays in its own Vault item");
  assert.deepEqual(w.events, ["connection.created"]);
  await assert.rejects(() => w.m.save(form(), { as: "deck" }), /already a connection/);
  const l = (await w.m.list()).connections;
  assert.equal(l.length, 1); assert.equal(l[0].light, "unknown"); assert.equal(l[0].host, "services.leadconnectorhq.com");
});

test("a missing key item stops the save and leaves nothing behind", async () => {
  const w = world();
  await assert.rejects(() => w.m.save(form({ credential: { item: "nope" } }), { as: "deck" }), /no item named nope/);
  assert.equal((await w.m.list()).connections.length, 0);
  assert.ok(!w.items.has("conn-gohighlevel-sales"));
  w.items.set("a-cred", { name: "a-cred", kind: "api-credential", updated: 1 });
  await assert.rejects(() => w.m.save(form({ credential: { item: "a-cred" } }), { as: "deck" }), /never hands out/);
});

test("the check runs through the derived credential and keeps its light in plain words", async () => {
  const w = world();
  await w.m.save(form(), { as: "deck" });
  w.setReply(input => { assert.equal(input.credential, "conn-gohighlevel-sales"); assert.equal(input.method, "GET"); assert.equal(input.url, "https://services.leadconnectorhq.com/locations/loc_1"); return { data: { status: 200 } }; });
  assert.deepEqual(await w.m.check("gohighlevel-sales"), { id: "gohighlevel-sales", light: "green", words: "connected" });
  w.setReply({ data: { status: 401 } });
  assert.equal((await w.m.check("gohighlevel-sales")).words, "the key was refused (401)");
  w.setReply({ data: { status: 404 } });
  assert.equal((await w.m.check("gohighlevel-sales")).words, "that id was not found (404)");
  w.setReply({ error: { code: "failed", message: "request timed out" } });
  assert.equal((await w.m.check("gohighlevel-sales")).words, "no answer from the host (timeout)");
  assert.equal((await w.m.list()).connections[0].light, "red");
  await assert.rejects(() => w.m.check("nope"), /no connection/);
});

test("a credential changed behind the record's back is out of step, does not run, and rebuilding fixes it", async () => {
  const w = world();
  await w.m.save(form(), { as: "deck" });
  w.setReply({ data: { status: 200 } });
  assert.equal((await w.m.check("gohighlevel-sales")).light, "green");
  w.items.get("conn-gohighlevel-sales").updated += 50; // someone put it again by hand
  assert.equal((await w.m.list()).connections[0].light, "out_of_step");
  const before = w.calls.filter(c => c.tool === "vault.request").length;
  const out = await w.m.check("gohighlevel-sales");
  assert.equal(out.light, "red"); assert.match(out.words, /changed outside/);
  assert.equal(w.calls.filter(c => c.tool === "vault.request").length, before, "nothing was sent through a credential the record did not write");
  await w.m.rebuild("gohighlevel-sales", "deck");
  assert.equal((await w.m.check("gohighlevel-sales")).light, "green");
  w.items.delete("conn-gohighlevel-sales");
  assert.equal((await w.m.list()).connections[0].light, "out_of_step", "a missing credential is out of step too");
});

test("update replaces the record and the credential; delete removes both", async () => {
  const w = world();
  await assert.rejects(() => w.m.save(form(), { as: "deck", replace: true }), /no connection/);
  await w.m.save(form(), { as: "deck" });
  await w.m.save(form({ headers: { Version: "2022-01-01" } }), { as: "deck", replace: true });
  assert.equal(JSON.parse(w.items.get("conn-gohighlevel-sales").fields.config).headers.version, "2022-01-01");
  assert.equal((await w.m.get("gohighlevel-sales")).declaration.headers.Version, "2022-01-01");
  assert.deepEqual(await w.m.remove("gohighlevel-sales", "deck"), { id: "gohighlevel-sales", removed: true });
  assert.ok(!w.items.has("conn-gohighlevel-sales")); assert.ok(w.items.has("ghl-pat"), "the key's own item stays");
  assert.equal((await w.m.list()).connections.length, 0);
});
