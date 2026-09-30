// @ts-check
// The vault module inside a real vyred, in a temp home: grants through a real module's
// ctx.vault.fetch, who may call what, the keystores, and the promise the whole thing rests on,
// that no value appears in an event, a log, a listing, the MCP server or a file on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { request, call } from "../daemon/client.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";
import { tempKeychain, onSearchList } from "./testing.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");

/** A module that uses one item and reports only its hash, never the value. */
const PROBE = `export default { async start(ctx) {
  ctx.tool("probe.use", { input: { type: "object", properties: { name: { type: "string" }, field: { type: "string" } } },
    run: async ({ name, field }) => { const v = await ctx.vault.fetch(name, field ? { field } : {});
      const c = await import("node:crypto"); return { sha: c.createHash("sha256").update(v).digest("hex") }; } });
  return { async stop() {} };
} };`;

/** A module that skips ctx.vault.fetch and calls vault.release itself, with nothing declared. */
const SNEAK = `export default { async start(ctx) {
  ctx.tool("sneak.try", { input: { type: "object", properties: { name: { type: "string" }, project: { type: "string" } } },
    run: async ({ name, project }) => { const r = await ctx.call("vault.release", { name, ...(project ? { project } : {}) }); return { refused: Boolean(r.error), message: r.error && r.error.message }; } });
  return { async stop() {} };
} };`;

async function boot(t, vault = { keystore: "file" }, { keep } = {}) {
  const root = keep || tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault }));
  const mods = path.join(root, "modules");
  if (!keep) {
    writeModule(mods, "probe", { does: { tools: ["probe.use"] }, needs: { vault: ["api-token", "site-login"] } }, PROBE);
    writeModule(mods, "sneak", { does: { tools: ["sneak.try"] } }, SNEAK);
  }
  const lines = [];
  const d = await start({ root, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  return { root, d, lines, as: caller => (tool, input = {}) => call(tool, input, { root, caller }) };
}

test("vault: put, list, grant, fetch through a real module, revoke", async t => {
  const { d, as } = await boot(t);
  t.after(() => d.stop());
  const cli = as("cli");
  assert.equal(d.registry.status().find(m => m.name === "vault")?.state, "running");
  const value = fake("token");

  assert.deepEqual((await cli("vault.put", { name: "api-token", kind: "api-key", description: "billing API", fields: { value }, hosts: ["https://api.example.com"] })).data,
    { name: "api-token", kind: "api-key", created: true });
  const list = (await cli("vault.list")).data;
  assert.equal(list.items[0].name, "api-token");
  assert.deepEqual(list.items[0].fields, ["value"]);
  assert.deepEqual(list.items[0].hosts, ["https://api.example.com"]);

  const before = await cli("probe.use", { name: "api-token" });
  assert.match(before.error.message, /not granted to probe/);

  assert.equal((await cli("vault.grant", { name: "api-token", module: "probe" })).data.grant.status, "active");
  assert.equal((await cli("probe.use", { name: "api-token" })).data.sha, sha(value));
  assert.deepEqual((await cli("vault.list")).data.items[0].grants, [{ module: "probe" }]);

  // Declaring an item is not enough and skipping the declaration is not a way round: the grant is the boundary.
  const sneak = (await cli("sneak.try", { name: "api-token" })).data;
  assert.equal(sneak.refused, true);
  assert.match(sneak.message, /not granted to sneak/);
  const undeclared = await cli("probe.use", { name: "other" });
  assert.match(undeclared.error.message, /does not declare/);

  // A grant scoped to one project (docs/design/session-credentials.md) only releases to a caller
  // naming that project; a caller with no project concept still gets it, as every caller did
  // before this column existed.
  await cli("vault.grant", { name: "api-token", module: "sneak", project: "harlow" });
  assert.equal((await cli("sneak.try", { name: "api-token" })).data.refused, false, "no project asked: matches any grant");
  const wrongProject = (await cli("sneak.try", { name: "api-token", project: "northwind" })).data;
  assert.equal(wrongProject.refused, true);
  assert.match(wrongProject.message, /not granted to sneak/);
  assert.equal((await cli("sneak.try", { name: "api-token", project: "harlow" })).data.refused, false);
  assert.deepEqual((await cli("vault.list")).data.items[0].grants.find(g => g.module === "sneak"), { module: "sneak", project: "harlow" });
  assert.equal((await cli("vault.revoke", { name: "api-token", module: "sneak", project: "harlow" })).data.revoked, 1);

  assert.equal((await cli("vault.revoke", { name: "api-token", module: "probe" })).data.revoked, 1);
  assert.match((await cli("probe.use", { name: "api-token" })).error.message, /not granted/);

  const trail = (await cli("vault.audit", { name: "api-token" })).data.entries.map(e => `${e.action}:${e.ok}`);
  assert.deepEqual(trail.reverse(), ["add:true", "release:false", "grant:true", "release:true", "release:false",
    "grant:true", "release:true", "release:false", "release:true", "revoke:true", "revoke:true", "release:false"]);
  const types = d.events.since(0, { limit: 1000 }).map(e => e.type);
  for (const ty of ["vault.item-added", "vault.granted", "vault.released", "vault.revoked"]) assert.ok(types.includes(ty), `no ${ty}`);
});

test("vault: login fields, TOTP, generate, env-set and delete", async t => {
  const { d, as } = await boot(t);
  t.after(() => d.stop());
  const cli = as("cli");
  const password = fake("pw");
  await cli("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password, totp: "JBSWY3DPEHPK3PXP" }, url: "https://mail.example.com/login" });
  assert.deepEqual((await cli("vault.list")).data.items[0].hosts, ["https://mail.example.com"]);
  assert.match((await cli("vault.totp", { name: "site-login" })).data.code, /^\d{6}$/);
  await cli("vault.grant", { name: "site-login", module: "probe" });
  assert.equal((await cli("probe.use", { name: "site-login" })).data.sha, sha(password), "a login hands over its password by default");
  assert.equal((await cli("probe.use", { name: "site-login", field: "username" })).data.sha, sha("alex@example.com"));
  assert.deepEqual((await cli("vault.match", { url: "https://mail.example.com/inbox" })).data.logins.map(l => l.name), ["site-login"]);

  const shown = (await cli("vault.generate", { words: 5 })).data;
  assert.match(shown.value, /^([a-z]{6}-){4}[a-z]{6}$/);
  const stored = (await cli("vault.generate", { length: 32, name: "new-pass" })).data;
  assert.deepEqual(Object.keys(stored).sort(), ["bits", "stored"]);
  assert.ok((await cli("vault.list")).data.items.some(i => i.name === "new-pass"));
  await cli("vault.generate", { name: "site-login" });
  assert.notEqual((await cli("probe.use", { name: "site-login" })).data.sha, sha(password), "generating into a login rotates its password");

  await cli("vault.put", { name: "stack-env", kind: "env-set", fields: { DB_URL: fake("db"), CACHE_URL: fake("cache") } });
  const env = (await cli("vault.inject", { items: [{ name: "stack-env" }, { name: "new-pass", env: "PASS" }] })).data.env;
  assert.deepEqual(Object.keys(env).sort(), ["CACHE_URL", "DB_URL", "PASS"]);
  assert.match((await cli("vault.put", { name: "bad-env", kind: "env-set", fields: { "not ok": "x" } })).error.message, /not allowed/);

  assert.equal((await cli("vault.delete", { name: "new-pass" })).data.deleted, "new-pass");
  assert.ok(!(await cli("vault.list")).data.items.some(i => i.name === "new-pass"));
});

test("vault: Claude is never the channel for a value, and cannot give access on its own", async t => {
  const { root, d, as } = await boot(t);
  t.after(() => d.stop());
  const cli = as("cli"), mcp = as("mcp");
  await cli("vault.put", { name: "api-token", fields: { value: fake("token") }, hosts: ["https://api.example.com"] });

  const refused = await mcp("vault.put", { name: "x", fields: { value: "y" } });
  assert.equal(refused.error.code, "denied");
  assert.equal((await mcp("vault.inject", { items: [{ name: "api-token" }] })).error.code, "denied");
  assert.equal((await mcp("vault.totp", { name: "api-token" })).error.code, "denied");
  assert.match((await mcp("vault.generate", {})).error.message, /give a name/);

  const offered = (await request("GET", "/v1/tools", undefined, { root, caller: "mcp" })).data.map(x => x.name);
  for (const hidden of ["vault.put", "vault.inject", "vault.approve", "vault.unlock", "vault.release", "vault.totp", "vault.delete"]) assert.ok(!offered.includes(hidden), `${hidden} is offered to Claude`);
  for (const shown of ["vault.list", "vault.grant", "vault.pass.create", "vault.offboard", "vault.import", "vault.audit"]) assert.ok(offered.includes(shown), `${shown} is missing for Claude`);

  // Claude's grant waits for a person.
  const g = (await mcp("vault.grant", { name: "api-token", module: "probe" })).data.grant;
  assert.equal(g.status, "pending");
  assert.match((await cli("probe.use", { name: "api-token" })).error.message, /not granted/);
  assert.deepEqual((await cli("vault.pending")).data.grants.map(x => x.id), [g.id]);
  assert.equal((await mcp("vault.approve", { id: g.id })).error.code, "denied");
  assert.equal((await cli("vault.approve", { id: g.id })).data.approved.status, "active");
  assert.ok((await cli("probe.use", { name: "api-token" })).data.sha);
  assert.equal((await mcp("vault.revoke", { name: "api-token", module: "probe" })).data.revoked, 1, "taking access away needs no one");

  // Nothing on the socket can pose as a module to reach vault.release.
  await cli("vault.grant", { name: "api-token", module: "probe" });
  const spoof = await call("vault.release", { name: "api-token" }, { root, caller: "module:probe" });
  assert.equal(spoof.error.code, "no_such_tool");
});

test("vault: the passphrase keystore stays locked until unlocked", async t => {
  const { d, as } = await boot(t, { keystore: "passphrase" });
  t.after(() => d.stop());
  const cli = as("cli");
  assert.match((await cli("vault.put", { name: "a", fields: { value: fake("a") } })).error.message, /passphrase/);
  assert.equal((await cli("vault.unlock", { passphrase: "a long test passphrase" })).data.unlocked, true);
  await cli("vault.put", { name: "api-token", fields: { value: fake("a") } });
  await cli("vault.grant", { name: "api-token", module: "probe" });
  await cli("vault.lock");
  assert.equal((await cli("vault.list")).data.locked, true);
  assert.match((await cli("probe.use", { name: "api-token" })).error.message, /locked/);
  assert.match((await cli("vault.unlock", { passphrase: "wrong" })).error.message, /does not open/);
  await cli("vault.unlock", { passphrase: "a long test passphrase" });
  assert.ok((await cli("probe.use", { name: "api-token" })).data.sha);
});

test("vault: under tests, the keychain keystore refuses the real login keychain", async t => {
  const { d, as } = await boot(t, { keystore: "keychain" });
  t.after(() => d.stop());
  assert.match((await as("cli")("vault.put", { name: "a", fields: { value: "x" } })).error.message, /temporary keychain/);
});

test("vault: the keychain keystore, in a temporary keychain, survives a restart", { skip: process.platform !== "darwin" }, async t => {
  const kc = await tempKeychain(t);

  const value = fake("kc");
  const first = await boot(t, { keystore: "keychain", keychain: kc });
  await first.as("cli")("vault.put", { name: "api-token", fields: { value } });
  await first.as("cli")("vault.grant", { name: "api-token", module: "probe" });
  assert.equal(fs.existsSync(path.join(first.root, "vault", "key")), false, "the key belongs in the keychain, not the data folder");
  await first.d.stop();

  const again = await boot(t, { keystore: "keychain", keychain: kc }, { keep: first.root });
  t.after(() => again.d.stop());
  const used = await again.as("cli")("probe.use", { name: "api-token" });
  assert.equal(used.data?.sha, sha(value), JSON.stringify(used.error));
  assert.equal(await onSearchList(kc), false, "the test keychain joined the user's search list");
});

/** Every file under a folder, as raw bytes. */
function everyFile(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) everyFile(p, out); else if (e.isFile()) out.push([p, fs.readFileSync(p)]);
  }
  return out;
}

/** The Vyre MCP server, as Claude Code runs it, asked for its tool list. */
function mcpList(root) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(REPO, "harness", "mcp", "server.js")], { env: { ...process.env, VYRE_HOME: root } });
    let buf = "";
    p.stdout.on("data", c => {
      buf += c;
      const line = buf.split("\n").find(l => l.includes('"id":2'));
      if (line) { p.kill(); resolve(line); }
    });
    p.on("error", reject);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    setTimeout(() => { p.kill(); reject(new Error("mcp server did not answer")); }, 10_000).unref();
  });
}

test("vault: no value appears in events, logs, listings, the MCP server, the HTTP API or any file", async t => {
  const { root, d, lines, as } = await boot(t);
  const cli = as("cli"), mcp = as("mcp");
  const values = [];
  const v = label => { const x = fake(label); values.push(x); return x; };

  // An upstream that echoes the credential back, so scrubbing is tested too.
  const api = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ saw: req.headers.authorization })); });
  await new Promise(r => api.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => api.close());
  const apiOrigin = `http://127.0.0.1:${/** @type {any} */ (api.address()).port}`;

  await cli("vault.put", { name: "api-token", kind: "api-key", fields: { value: v("token") }, hosts: [apiOrigin] });
  await cli("vault.put", { name: "site-login", kind: "login", fields: { username: v("user"), password: v("pw"), totp: "JBSWY3DPEHPK3PXP" }, url: "https://mail.example.com" });
  await cli("vault.put", { name: "team-card", kind: "card", fields: { holder: "A Person", number: v("card"), expiry: "01/30", cvv: v("cvv") } });
  const envFile = path.join(root, "fixture.env");
  fs.writeFileSync(envFile, `FIXTURE_API_KEY=${v("env")}\n`);
  const envItem = (await cli("vault.import", { file: envFile })).data.added[0];
  assert.ok(envItem, "the .env file became an env-set");
  fs.rmSync(envFile);

  await cli("vault.grant", { name: "api-token", module: "probe" });
  await cli("probe.use", { name: "api-token" });
  await cli("vault.inject", { items: [{ name: envItem }] });
  await cli("vault.totp", { name: "site-login" });
  await cli("sneak.try", { name: "site-login" });
  await mcp("vault.put", { name: "x", fields: { value: "not stored" } });

  // A second Vyre in-process, so a relayed pass and a sealed pass both run.
  const holder = await boot(t);
  t.after(() => holder.d.stop());
  const card = (await holder.as("cli")("vault.identity")).data.card;
  // This home has no relay listener, so the relayed pass is refused; the sealed one goes.
  assert.match((await cli("vault.pass.create", { holder: "teammate", card, items: ["api-token"] })).error.message, /no relay address/);
  const sealed = (await cli("vault.pass.create", { holder: "teammate", card, items: ["team-card"], mode: "sealed" })).data;
  await holder.as("cli")("vault.pass.accept", { ticket: sealed.ticket });
  await cli("vault.offboard", { person: "teammate" });

  const texts = [
    JSON.stringify(d.events.since(0, { limit: 5000 })),
    JSON.stringify(holder.d.events.since(0, { limit: 5000 })),
    lines.join("\n"), holder.lines.join("\n"),
    JSON.stringify((await cli("vault.list")).data), JSON.stringify((await mcp("vault.list")).data),
    JSON.stringify((await holder.as("cli")("vault.list")).data),
    JSON.stringify((await cli("vault.audit", { limit: 1000 })).data),
    JSON.stringify((await cli("vault.pass.list")).data), JSON.stringify((await cli("vault.pending")).data),
    JSON.stringify(await request("GET", "/v1/tools", undefined, { root, caller: "mcp" })),
    JSON.stringify(await request("GET", "/v1/tools", undefined, { root })),
    JSON.stringify(await request("GET", "/v1/events?limit=1000", undefined, { root })),
    await mcpList(root),
    sealed.ticket, // a ticket is safe to send: sealed items are ciphertext to the holder's key
  ];
  // The scan waits for WAL checkpoints: every write is in a file by now.
  const files = [...everyFile(root), ...everyFile(holder.root)];
  await d.stop();

  for (const value of values) {
    for (const [i, text] of texts.entries()) assert.ok(!text.includes(value), `a value appeared in output ${i}`);
    for (const [file, bytes] of files) {
      // The holder's own sealed copy of the card is theirs by design; it is still ciphertext on disk.
      assert.ok(!bytes.includes(Buffer.from(value)), `a value appeared in plain text in ${path.relative(os.tmpdir(), file)}`);
    }
  }
  assert.equal(values.length, 6);
});

test("vault: a module may put its own items and grant them, and nothing else", async t => {
  const { root, d, as } = await boot(t);
  t.after(() => d.stop());
  writeModule(path.join(root, "modules"), "stash", { does: { tools: ["stash.store"] } }, `export default { async start(ctx) {
    ctx.tool("stash.store", { input: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, grants: { type: "array" } } },
      run: async input => { const r = await ctx.call("vault.put", { kind: "api-key", ...input }); return r.error ? { error: r.error.message } : r.data; } });
    return { async stop() {} };
  } };`);
  // "stash", not "onboard": onboard is a core module on a box and would shadow this one.
  await d.stop();
  const again = await boot(t, { keystore: "file" }, { keep: root });
  t.after(() => again.d.stop());
  const cli = again.as("cli");
  const token = fake("setup");

  const stored = (await cli("stash.store", { name: "api-token", value: token, grants: ["probe"] })).data;
  assert.deepEqual(stored, { name: "api-token", kind: "api-key", created: true, granted: ["probe"] });
  assert.equal((await cli("probe.use", { name: "api-token" })).data.sha, sha(token));
  assert.equal((await cli("vault.list")).data.items[0].origin, "module:stash");
  assert.equal((await cli("stash.store", { name: "api-token", value: fake("again") })).data.created, false, "it may replace what it made");

  await cli("vault.put", { name: "site-login", kind: "login", fields: { password: fake("pw"), username: "a" } });
  assert.match((await cli("stash.store", { name: "site-login", value: "x" })).data.error, /was not made by stash/);
  assert.match((await cli("sneak.try", { name: "api-token" })).data.message, /not granted to sneak/);
  assert.equal((await again.as("mcp")("vault.put", { name: "z", value: "y" })).error.code, "denied");
  assert.match((await cli("vault.put", { name: "q", value: "y", grants: ["probe"] })).error.message, /people use vault.grant/);
});

test("vault: a per-agent module fetches dynamic names, still only with a grant per item", async t => {
  const { root, d } = await boot(t);
  writeModule(path.join(root, "modules"), "roster", { does: { tools: ["roster.fetch"] }, needs: { vault: ["per-agent"] } }, `export default { async start(ctx) {
    ctx.tool("roster.fetch", { input: { type: "object", properties: { name: { type: "string" } } },
      run: async ({ name }) => { try { const v = await ctx.vault.fetch(name); return { length: v.length }; } catch (e) { return { error: e.message }; } } });
    return { async stop() {} };
  } };`);
  await d.stop();
  const again = await boot(t, { keystore: "file" }, { keep: root });
  t.after(() => again.d.stop());
  const cli = again.as("cli");
  const token = fake("setup");
  await cli("vault.put", { name: "juno-setup-token", value: token });
  assert.match((await cli("roster.fetch", { name: "juno-setup-token" })).data.error, /not granted to roster/);
  await cli("vault.grant", { name: "juno-setup-token", module: "roster" });
  assert.deepEqual((await cli("roster.fetch", { name: "juno-setup-token" })).data, { length: token.length });
});

test("vault: behind tailscale serve, a relayed pass answers only its holder's Tailscale login", async t => {
  const token = fake("token");
  const api = http.createServer((req, res) => { res.end(JSON.stringify({ ok: req.headers.authorization === `Bearer ${token}` })); });
  await new Promise(r => api.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => api.close());
  const apiOrigin = `http://127.0.0.1:${/** @type {any} */ (api.address()).port}`;

  // A stand-in for tailscale serve: it proxies to the relay listener and sets the identity
  // header from whoever is calling, which here is whatever `as` says.
  let as = /** @type {string|null} */ ("mate@example.com");
  const free = await new Promise(r => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => r(p)); }); });
  const serve = http.createServer((req, res) => {
    const headers = { ...req.headers };
    delete headers["tailscale-user-login"];
    if (as) headers["tailscale-user-login"] = as;
    const up = http.request({ host: "127.0.0.1", port: free, path: req.url, method: req.method, headers }, r => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  await new Promise(r => serve.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => serve.close());
  const serveUrl = `http://127.0.0.1:${/** @type {any} */ (serve.address()).port}`;

  const owner = await boot(t, { keystore: "file", relay: { host: "127.0.0.1", port: free, url: serveUrl, identity: "tailscale" } });
  t.after(() => owner.d.stop());
  const mate = await boot(t, { keystore: "file", login: "mate@example.com" });
  t.after(() => mate.d.stop());
  const o = owner.as("cli"), m = mate.as("cli");

  await o("vault.put", { name: "api-token", kind: "api-key", value: token, hosts: [apiOrigin] });
  const card = (await m("vault.identity")).data.card;
  const { ticket } = (await o("vault.pass.create", { holder: "teammate", card, items: ["api-token"] })).data;
  await m("vault.pass.accept", { ticket });
  const use = () => m("vault.relay", { item: "api-token", request: { url: `${apiOrigin}/`, headers: { authorization: "Bearer {{vault}}" } } });

  assert.equal(JSON.parse((await use()).data.body).ok, true);
  as = "someone-else@example.com";
  assert.match((await use()).error.message, /another Tailscale user/);
  as = null;
  assert.match((await use()).error.message, /only through tailscale serve/);
  const trail = (await o("vault.audit", { name: "api-token" })).data.entries;
  assert.ok(trail.some(e => e.action === "relay" && e.ok && /as mate@example\.com/.test(e.why)));
});

test("vault: on the box (identity whois), a relay ignores the identity header and refuses non-tailnet peers", async t => {
  const token = fake("token");
  const free = await new Promise(r => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => r(p)); }); });
  // The relay is on loopback here, so every peer is off the tailnet and whois is never asked.
  const owner = await boot(t, { keystore: "file", relay: { host: "127.0.0.1", port: free, identity: "whois" } });
  t.after(() => owner.d.stop());
  const mate = await boot(t, { keystore: "file", login: "mate@example.com" });
  t.after(() => mate.d.stop());
  const o = owner.as("cli"), m = mate.as("cli");
  await o("vault.put", { name: "api-token", kind: "api-key", value: token, hosts: ["https://api.example.com"] });
  const card = (await m("vault.identity")).data.card;
  const { ticket } = (await o("vault.pass.create", { holder: "teammate", card, items: ["api-token"] })).data;
  await m("vault.pass.accept", { ticket });
  // A forged header, as any local process could send it, counts for nothing.
  const res = await fetch(`http://127.0.0.1:${free}/v1/relay`, { method: "POST", headers: { "content-type": "application/json", "tailscale-user-login": "mate@example.com" },
    body: JSON.stringify({ pass: "none" }) });
  assert.equal(res.status, 403);
  const use = await m("vault.relay", { item: "api-token", request: { url: "https://api.example.com/", headers: { authorization: "Bearer {{vault}}" } } });
  assert.match(JSON.stringify(use), /only people on the tailnet/);
});
