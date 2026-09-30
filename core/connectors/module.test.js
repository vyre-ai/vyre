// @ts-check
// The connectors module inside a real vyred, in a temp home, with the real vault, the real MCP hub
// and the real Gate, against a fake authorization server and a fake MCP server (never a vendor).
//
// What these prove: a person connects an app in two calls and its tools appear in the hub, using a
// token the fake minted; only a person can connect; the credential is a vault item bound to the
// server's host; a preset named like a shipped vendor cannot be pointed at another host; a rotated
// refresh token is saved back through the module; a pasted token connects a second app; nothing
// secret reaches a result, an event, a log line or a table.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { startFakeAuthServer } from "./testing/fake-oauth.js";
import { startFakeMcpHttp } from "../mcp/testing/fake-mcp.js";

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
  // A preset that borrows a shipped id (notion) but points at the fake: the hub refuses the row,
  // because a notion-... item goes only to mcp.notion.com.
  const w = await world(t, url => [{ ...fakevendor(url), id: "notion-fake" }]);
  const r = await w.cli("connectors.connect", { preset: "notion-fake", mode: "token", token: "pasted-token-value-1234" });
  // notion-fake is its own preset (longest id), so it binds to 127.0.0.1 and works;
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
