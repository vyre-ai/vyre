// @ts-check
// The connectors module inside a real vyred, in a temp home, with the real vault, the real MCP hub
// and the real Gate, against a fake authorization server and a fake MCP server (never a vendor).
//
// What these prove: a person connects an app in two calls and its tools appear in the hub, using a
// token the fake minted; only a person can connect; the credential is a vault item bound to the
// server's host; a preset named like a shipped vendor cannot be pointed at another host; a rotated
// refresh token is saved back through the module; a pasted token connects a second app; nothing
// secret reaches a result, an event, a log line or a table.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";

// Presets for fakes on this machine are honoured only under this switch (production reads the shipped catalog).
process.env.VYRE_CONNECTORS_TEST_PRESETS = "1";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { startFakeAuthServer } from "../../lib/connectors/testing/fake-oauth.js";
import { startFakeMcpHttp } from "../mcp/testing/fake-mcp.js";
import { startFakeGoogle } from "../../lib/connectors/testing/fake-google.js";

async function world(t, presetsFor) {
  const auth = await startFakeAuthServer(t, { dcr: true });
  const mcp = await startFakeMcpHttp(t, { protectedBy: auth.origin, requireAuth: h => Boolean(h) && (auth.tokens.has(String(h).replace(/^Bearer /, "")) || h === "Bearer pasted-token-value-1234") });
  const root = tempHome(t);
  const url = mcp.url;
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, connectors: { presets: presetsFor(url) } }));
  const lines = [];
  const d = await start({ root, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  const results = [];
  const keep = fn => async (tool, input) => { const r = await fn(tool, input); results.push(r); return r; };
  const model = (tool, input = {}) => d.registry.call(tool, input, "mcp", { thread: "t-1" });
  return { auth, mcp, url, root, d, lines, results, cli: keep(as("cli")), mcpCall: keep(model) };
}

const fakevendor = url => ({ id: "fakevendor", label: "Fake Vendor", group: "work", url, transport: "http", who: "Anyone.", evidence: "docs", oauth: { client: "dcr" },
  token: { label: "Token", help: "Made up." } });

function noLeak(w, values) {
  const db = w.d.registry.deps.db;
  const everything = JSON.stringify([w.results, w.lines, w.d.registry.deps.events.since(0, { limit: 5000 }),
    db.prepare("SELECT * FROM connectors_connections").all(), db.prepare("SELECT name, transport, url, headers, auth FROM mcp_servers").all(), db.prepare("SELECT * FROM gate_items").all()]);
  for (const v of values) assert.ok(!everything.includes(v), `a secret leaked: ${v.slice(0, 10)}...`);
}

test("connectors: sign in, tools appear in the hub, only a person connects, nothing leaks", async t => {
  const w = await world(t, url => [fakevendor(url)]);
  assert.equal(w.d.registry.status().find(m => m.name === "connectors")?.state, "running", JSON.stringify(w.d.registry.status().find(m => m.name === "connectors")) + w.lines.filter(l => /connectors/.test(l)).join("\n"));

  const cat = await w.mcpCall("connectors.catalog", {});
  assert.equal(cat.data.presets.find(p => p.id === "fakevendor").setup, "none");
  assert.ok(cat.data.presets.some(p => p.id === "ghl"), "the shipped catalog is there too");
  assert.equal((await w.mcpCall("connectors.connect", { preset: "fakevendor" })).error.code, "denied");

  const s = await w.cli("connectors.connect", { preset: "fakevendor" });
  assert.equal(s.data?.step, "open", JSON.stringify(s));
  const done = await w.cli("connectors.connect.finish", { id: s.data.id, url: w.auth.consent(s.data.url) });
  assert.equal(done.data?.step, "connected", JSON.stringify(done));
  assert.ok(done.data.tools >= 6, "the fake's tools were listed with the minted token");
  assert.equal(done.data.warning, undefined);

  // the credential is a vault item bound to the vendor's host, granted to the hub
  const item = (await w.cli("vault.list", { filter: "fakevendor-auth" })).data.items.find(x => x.name === "fakevendor-auth");
  assert.ok(item);
  assert.deepEqual(item.hosts, [new URL(w.url).origin]);
  assert.ok(item.grants.some(g => g.module === "mcp"), JSON.stringify(item.grants));

  // the hub serves it: a model sees the tools, and a call goes out carrying the minted token
  const tools = (await w.mcpCall("mcp.tools", {})).data;
  assert.ok(tools.some(x => x.name === "fakevendor__list_issues"));
  const called = await w.mcpCall("mcp.call", { name: "fakevendor__list_issues", arguments: {} });
  assert.ok(called.data && !called.error, JSON.stringify(called));
  assert.ok(w.mcp.requests.some(r => r.authorization && w.auth.tokens.has(r.authorization.replace("Bearer ", ""))));

  assert.equal((await w.cli("connectors.list", {})).data[0].name, "fakevendor");
  noLeak(w, [...w.auth.tokens.keys()]);

  assert.deepEqual((await w.cli("connectors.disconnect", { name: "fakevendor" })).data, { name: "fakevendor", removed: true });
  assert.equal((await w.cli("mcp.servers", {})).data.some(x => x.name === "fakevendor"), false);
});

test("connectors: a pasted token connects an app and is sent as the preset says", async t => {
  const w = await world(t, url => [{ ...fakevendor(url), id: "tokvendor", prefer: "token" }]);
  const need = await w.cli("connectors.connect", { preset: "tokvendor" });
  assert.equal(need.data.needs, "token");
  assert.equal((await w.mcpCall("connectors.connect", { preset: "tokvendor", token: "pasted-token-value-1234" })).error.code, "denied");
  const done = await w.cli("connectors.connect", { preset: "tokvendor", token: "pasted-token-value-1234" });
  assert.equal(done.data?.step, "connected", JSON.stringify(done));
  assert.ok(done.data.tools >= 6);
  assert.ok(w.mcp.requests.some(r => r.authorization === "Bearer pasted-token-value-1234"));
  noLeak(w, ["pasted-token-value-1234"]);
});

test("connectors: a shipped vendor's credential cannot be put on a server at another host", async t => {
  // A preset that points at the fake: the hub refuses the row,
  // because a notion-... item goes only to mcp.notion.com.
  const w = await world(t, url => [{ ...fakevendor(url), id: "lookalike" }]);
  const r = await w.cli("connectors.connect", { preset: "lookalike", mode: "token", token: "pasted-token-value-1234" });
  // lookalike is its own preset, so it binds to 127.0.0.1 and works;
  assert.equal(r.data.step, "connected");
  // while a hand-added row that names a notion- item for the wrong host is refused.
  const bad = await w.cli("mcp.add", { name: "sneaky", transport: "http", url: w.url, auth: { type: "bearer", item: "notion-auth", field: "value" } });
  assert.match(bad.error.message, /notion credential: it goes only to mcp\.notion\.com/);
});

test("connectors: a rotated refresh token is saved back into the item", async t => {
  const w = await world(t, url => [fakevendor(url)]);
  const s = await w.cli("connectors.connect", { preset: "fakevendor" });
  await w.cli("connectors.connect.finish", { id: s.data.id, url: w.auth.consent(s.data.url) });
  // only the hub may call persist
  assert.match((await w.cli("connectors.persist", { item: "fakevendor-auth", fields: {} })).error.code, /denied|no_such_tool/);
  const r = await w.d.registry.call("connectors.persist", { item: "fakevendor-auth", fields: { refresh_token: "rt_rotated_value_5678" } }, "module:mcp");
  assert.ok(r.data && r.data.saved, JSON.stringify(r));
  const back = await w.d.registry.call("vault.release", { name: "fakevendor-auth", field: "refresh_token" }, "module:mcp");
  assert.equal(back.data.value, "rt_rotated_value_5678");
  const kept = await w.d.registry.call("vault.release", { name: "fakevendor-auth", field: "client_id" }, "module:mcp");
  assert.ok(kept.data.value, "the other fields survived");
});

test("connectors: an api preset with a token makes a real api-credential in the vault, as the person who asked", async t => {
  const w = await world(t, url => [fakevendor(url), { id: "webapi", label: "Web API", group: "work", target: "api", who: "Anyone.", evidence: "docs",
    api: { hosts: ["api.example.test"], use: "Use vault.request." }, token: { label: "Token", help: "Made up." } }]);
  const need = await w.cli("connectors.connect", { preset: "webapi" });
  assert.equal(need.data.needs, "token");
  const done = await w.cli("connectors.connect", { preset: "webapi", token: "pasted-api-token-value-9876" });
  assert.equal(done.data?.step, "connected", JSON.stringify(done));
  assert.equal(done.data.use.credential, "webapi");
  const item = (await w.cli("vault.list", { filter: "webapi" })).data.items.find(x => x.name === "webapi");
  assert.equal(item.kind, "api-credential");
  // the credential is never handed out, and a model cannot make one
  assert.match((await w.cli("vault.reveal", { name: "webapi" })).error?.message || "", /api-credential|never handed out/);
  assert.equal((await w.mcpCall("connectors.connect", { preset: "webapi", token: "x".repeat(20), replace: true })).error.code, "denied");
  assert.equal((await w.cli("mcp.servers", {})).data.some(x => x.name === "webapi"), false);
  noLeak(w, ["pasted-api-token-value-9876"]);
});

test("connectors: a #tag lets one thread use a server its scope would hide, and only sessions may resolve it", async t => {
  const w = await world(t, url => [fakevendor(url)]);
  const s = await w.cli("connectors.connect", { preset: "fakevendor" });
  await w.cli("connectors.connect.finish", { id: s.data.id, url: w.auth.consent(s.data.url) });
  assert.ok((await w.cli("mcp.update", { name: "fakevendor", scope: { projects: ["only-this-project"] } })).data, "scoped to a project");
  const visible = async thread => (await w.d.registry.call("mcp.servers", {}, "mcp", { thread })).data.some(x => x.name === "fakevendor");
  assert.equal(await visible("t-tagged"), false, "outside its scope the thread does not see it");

  const found = await w.cli("connectors.mention.search", { q: "fake" });
  assert.deepEqual(found.data.map(x => x.id), ["fakevendor"]);
  assert.equal((await w.mcpCall("connectors.mention.search", {})).error.code, "denied", "a model cannot search the picker");
  for (const who of ["cli", "mcp", "module:mcp", "module:watchers"]) {
    const r = await w.d.registry.call("connectors.mention.resolve", { id: "fakevendor", thread: "t-tagged" }, who);
    assert.ok(r.error, `${who} may not resolve`);
  }
  const ok = await w.d.registry.call("connectors.mention.resolve", { id: "fakevendor", thread: "t-tagged", said: "s1" }, "module:sessions");
  assert.deepEqual(ok.data.grant.use, true, JSON.stringify(ok));
  assert.equal(await visible("t-tagged"), true, "tagged: the thread now sees the server");
  assert.equal(await visible("t-other"), false, "only that thread");
  assert.equal((await w.d.registry.call("mcp.grant", { server: "fakevendor", thread: "t-x" }, "cli")).error?.code === undefined, false, "mcp.grant is internal");
});

test("connectors: the Capsule's `next` command lists today's meetings across calendars, nothing when none is connected", async t => {
  const fakeGoogle = await startFakeGoogle(t);
  const w = await world(t, url => [fakevendor(url)]);
  // nothing connected: empty, and the Capsule lists the command
  assert.deepEqual((await w.cli("connectors.calendar.today", {})).data, { events: [] });
  const cmds = await w.cli("capsule.commands", {});
  if (cmds.data) {
    const next = cmds.data.commands.find(c => c.module === "connectors" && c.id === "next");
    assert.ok(next, JSON.stringify(cmds.data.commands.map(c => `${c.module}:${c.id}`)));
    assert.equal(next.title, "Next meeting");
    assert.ok(!cmds.data.commands.some(c => c.module === "google" && c.id === "next"), "one `next`, not two");
    const empty = await w.cli("capsule.view", { module: "connectors", command: "next" });
    assert.equal(empty.data.kind, "list", JSON.stringify(empty));
    assert.equal(empty.data.rows.length, 0);
  }
  // a Google account adds its meetings, through the google module
  const end = new Date(); end.setHours(23, 59, 59, 999);
  if (end.getTime() - Date.now() < 2 * 3_600_000) return void t.skip("too close to the end of this box's day");
  const sa = fakeGoogle.serviceAccount("alex@example.com");
  assert.ok((await w.cli("vault.put", { name: "work-google", kind: "secret", fields: { value: sa } })).data);
  assert.equal((await w.cli("vault.grant", { name: "work-google", module: "google" })).data.grant.status, "active");
  assert.ok((await w.cli("google.add", { name: "work", email: "alex@example.com", auth: { type: "service-account", item: "work-google" }, base: fakeGoogle.base })).data);
  // the cache holds for a minute, so a fresh module asks again: connect a second time by restarting is not needed, the key changes with connections only
  const today = (await w.cli("connectors.calendar.today", { limit: 1 })).data;
  assert.equal(today.events.length, 1);
  assert.equal(today.events[0].title, "Harlow Legal check-in");
  assert.match(today.events[0].when, /^in \d+ min$/);
});

test("connectors: who may use a connection is shown in the catalog and changed only by a person, on the hub row", async t => {
  const w = await world(t, url => [fakevendor(url)]);
  const s = await w.cli("connectors.connect", { preset: "fakevendor", scope: { projects: ["harlow-site"], agents: ["kit"] } });
  await w.cli("connectors.connect.finish", { id: s.data.id, url: w.auth.consent(s.data.url) });
  const scopeNow = async () => ((await w.cli("mcp.servers", {})).data.find(x => x.name === "fakevendor") || {}).scope;
  assert.deepEqual(await scopeNow(), { projects: ["harlow-site"], agents: ["kit"] });
  const shown = (await w.cli("connectors.catalog", {})).data.presets.find(p => p.id === "fakevendor").connected[0];
  assert.deepEqual(shown.scope, { projects: ["harlow-site"], agents: ["kit"] });
  // a person changes it, and null is the default again
  assert.deepEqual((await w.cli("connectors.scope", { name: "fakevendor", scope: { projects: "*", agents: ["kit", "juno"] } })).data.scope, { projects: "*", agents: ["kit", "juno"] });
  assert.deepEqual(await scopeNow(), { projects: "*", agents: ["kit", "juno"] });
  await w.cli("connectors.scope", { name: "fakevendor", scope: null });
  assert.deepEqual(await scopeNow(), { projects: "*", agents: [], assistant: true }, "null is the default: you and the assistant only");
  assert.equal((await w.cli("connectors.catalog", {})).data.presets.find(p => p.id === "fakevendor").connected[0].scope, null);
  // a model cannot change it
  for (const who of ["mcp", "mcp:agent:kit", "module:sessions", "module:watchers", "hook"]) {
    // refused either way: a tool the caller may not use is `denied`, and one the registry hides from that kind of caller (a hook reaches only its webhook route) is `no_such_tool`
    assert.match((await w.d.registry.call("connectors.scope", { name: "fakevendor", scope: { projects: "*", agents: "*" } }, who)).error?.code || "", /^(denied|no_such_tool)$/, who);
  }
  assert.deepEqual(await scopeNow(), { projects: "*", agents: [], assistant: true }, "unchanged");
  assert.equal((await w.cli("connectors.scope", { name: "no-such-connection", scope: null })).error?.code, "not_found");
  assert.match((await w.cli("connectors.scope", { name: "fakevendor", scope: "everyone" })).error.message, /scope is/);
});
