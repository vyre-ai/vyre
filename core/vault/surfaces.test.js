// @ts-check
// surfaces tests: sessions, reveal, copy, TOTP and native fill inside a real vyred in a temp home.
// The Swift helpers are fakes (vault.testHelpers, honoured only under node --test) that record
// hashes, so no test writes the real clipboard or types into an app. The canary may come back
// from vault.reveal and reach a helper's stdin, and nowhere else.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { request, call } from "../daemon/client.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { writeFakes } from "./mac/fakes.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mac = process.platform === "darwin";
const canary = label => `fixture-canary-${label}-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await wait(25); }
  throw new Error("timed out waiting");
}

/** A module that tries to reach the person-only tools. */
const SNOOP = `export default { async start(ctx) {
  ctx.tool("snoop.try", { input: { type: "object", properties: { tool: { type: "string" }, name: { type: "string" } } },
    run: async ({ tool, name }) => { const r = await ctx.call(tool, { name, app: { bundle: "com.apple.Safari", pid: 1 }, surface: "deck" }); return { code: r.error && r.error.code }; } });
  return { async stop() {} };
} };`;

async function boot(t, { typeMode = "ok" } = {}) {
  const root = tempHome(t);
  const fakes = writeFakes(path.join(root, "fakes"), { typeMode });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "local", vault: { keystore: "file", testHelpers: fakes.helpers } }));
  writeModule(path.join(root, "modules"), "snoop", { does: { tools: ["snoop.try"] } }, SNOOP);
  const lines = [];
  const d = await start({ root, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  const clip = () => { try { return JSON.parse(fs.readFileSync(fakes.state.clip, "utf8")); } catch { return null; } };
  return { root, d, lines, as, fakes, clip };
}

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

const PERSON_ONLY = ["vault.reveal", "vault.copy", "vault.fill.native", "vault.session.open", "vault.session.status"];

test("surfaces: only people reach reveal, copy, fill and sessions; Claude and modules never see them", async t => {
  const { root, d, as } = await boot(t);
  t.after(() => d.stop());
  const cli = as("cli"), mcp = as("mcp");
  await cli("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: canary("pw") }, url: "https://mail.example.com" });
  const offered = (await request("GET", "/v1/tools", undefined, { root, caller: "mcp" })).data.map(x => x.name);
  for (const tool of PERSON_ONLY) {
    assert.ok(!offered.includes(tool), `${tool} is offered to Claude`);
    assert.equal((await mcp(tool, { name: "site-login", surface: "deck", session: "x", app: { bundle: "com.apple.Safari", pid: 1 } })).error.code, "denied", tool);
    assert.equal((await cli("snoop.try", { tool, name: "site-login" })).data.code, "denied", `a module reached ${tool}`);
  }
  assert.ok(offered.includes("vault.session.close"), "closing a session takes access away, so anyone may");
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "core", "vault", "module.json"), "utf8"));
  for (const tool of [...PERSON_ONLY, "vault.session.close"]) assert.ok(manifest.does.tools.includes(tool), tool);
  // An object in the order the Capsule lists them; "#..." names a second action on one tool.
  assert.deepEqual(Object.keys(manifest.shows.capsule), ["results:vault.search", "action:vault.fill.native", "action:vault.copy",
    "action:vault.copy#username", "action:vault.copy#totp", "action:vault.totp", "action:vault.lock"]);
  for (const v of Object.values(manifest.shows.capsule)) assert.equal(typeof v.title, "string");
});

test("surfaces: a session opens, reports, and closes; its token is in no event", async t => {
  const { d, as } = await boot(t);
  t.after(() => d.stop());
  const local = as("local");
  const o = (await local("vault.session.open", { surface: "deck", ttl_s: 600 })).data;
  assert.equal(Buffer.from(o.session, "base64url").length, 32);
  assert.equal(o.surface, "deck");
  const st = (await local("vault.session.status", { session: o.session })).data;
  assert.equal(st.unlocked, true);
  assert.equal(st.surface, "deck");
  assert.deepEqual((await as("mcp")("vault.session.close", { session: o.session })).data, { closed: true });
  assert.equal((await local("vault.session.status", { session: o.session })).data.unlocked, false);
  assert.match((await local("vault.session.open", { surface: "browser" })).error.message, /surface|enum|one of/);
  const ev = d.events.since(0, { limit: 1000 });
  assert.ok(ev.some(e => e.type === "vault.unlocked") && ev.some(e => e.type === "vault.locked"));
  assert.ok(!JSON.stringify(ev).includes(o.session));
});

test("surfaces: reveal shows one field; TOTP gives code, period and remaining", async t => {
  const { d, as } = await boot(t);
  t.after(() => d.stop());
  const cli = as("cli");
  const pw = canary("pw");
  await cli("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: pw, totp: "JBSWY3DPEHPK3PXP" }, url: "https://mail.example.com" });
  await cli("vault.put", { name: "stack-env", kind: "env-set", fields: { DB_URL: canary("db") } });
  assert.deepEqual((await cli("vault.reveal", { name: "site-login" })).data, { value: pw, concealAfter: 30 });
  assert.equal((await cli("vault.reveal", { name: "site-login", field: "username" })).data.value, "alex@example.com");
  assert.match((await cli("vault.reveal", { name: "site-login", field: "pin" })).error.message, /has no field pin/);
  assert.match((await cli("vault.reveal", { name: "stack-env" })).error.message, /name the field/);
  assert.match((await cli("vault.reveal", { name: "nope" })).error.message, /no item named nope/);
  const code = (await cli("vault.totp", { name: "site-login" })).data;
  assert.deepEqual(Object.keys(code).sort(), ["code", "period", "remaining"]);
  assert.equal(code.period, 30);
  const ev = d.events.since(0, { limit: 1000 }).filter(e => e.type === "vault.revealed");
  assert.deepEqual(ev.map(e => e.payload), [{ name: "site-login", field: "password", surface: "cli" }, { name: "site-login", field: "username", surface: "cli" }]);
});

test("surfaces: copy never returns the value; lock and screen lock clear it and end sessions", { skip: !mac }, async t => {
  const { d, as, clip, fakes } = await boot(t);
  t.after(() => d.stop());
  const cli = as("cli"), local = as("local");
  const pw = canary("pw");
  await cli("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: pw }, url: "https://mail.example.com" });

  const c = (await local("vault.copy", { name: "site-login" })).data;
  assert.deepEqual(Object.keys(c).sort(), ["clearsAt", "copied", "said"]);
  assert.equal(c.copied, true);
  assert.ok(c.clearsAt > Date.now() + 80_000);
  await until(() => clip()?.hash === sha(pw));

  const s = (await local("vault.session.open", { surface: "capsule" })).data;
  await cli("vault.lock");
  await until(() => clip()?.hash === null);
  assert.equal((await local("vault.session.status", { session: s.session })).data.unlocked, false, "vault.lock ends sessions");

  // The watcher's screen-lock signal does the same.
  const s2 = (await local("vault.session.open", { surface: "deck" })).data;
  await local("vault.copy", { name: "site-login", field: "username", session: s2.session });
  await until(() => clip()?.hash === sha("alex@example.com"));
  await wait(150);
  fs.writeFileSync(fakes.state.trigger, "screen-lock");
  await until(async () => (await local("vault.session.status", { session: s2.session })).data.unlocked === false);
  await until(() => clip()?.hash === null);
  const trail = (await cli("vault.audit", { limit: 100 })).data.entries;
  assert.ok(trail.some(e => e.action === "auto-lock" && /screen-lock/.test(e.why)));
  assert.ok(trail.some(e => e.action === "copy" && e.ok && /on deck/.test(e.why)));
});

test("surfaces: fill.native hands the login to the helper and reports only what it filled", { skip: !mac }, async t => {
  const { d, as, fakes } = await boot(t);
  t.after(() => d.stop());
  const cli = as("cli"), local = as("local");
  const pw = canary("pw");
  await cli("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: pw }, url: "https://mail.example.com" });
  const out = (await local("vault.fill.native", { name: "site-login", app: { bundle: "com.apple.Safari", pid: 4242 } })).data;
  assert.deepEqual(out, { filled: ["username", "password"], via: "ax", app: "com.apple.Safari", said: "Filled site-login in Safari" });
  const got = JSON.parse(fs.readFileSync(fakes.state.type, "utf8"));
  assert.equal(got.password, sha(pw));
  assert.deepEqual(got.hosts, ["https://mail.example.com"]);
  assert.match((await local("vault.fill.native", { name: "site-login", app: { bundle: "com.example.Notes", pid: 7 } })).error.message, /not set up for Notes/);
});

test("surfaces: a helper's refusal comes back in its own words", { skip: !mac }, async t => {
  const { d, as } = await boot(t, { typeMode: "not_trusted" });
  t.after(() => d.stop());
  await as("cli")("vault.put", { name: "site-login", kind: "login", fields: { username: "a", password: canary("pw") }, url: "https://mail.example.com" });
  assert.equal((await as("local")("vault.fill.native", { name: "site-login", app: { bundle: "com.apple.Safari", pid: 1 } })).error.message, "fixed words for not_trusted");
});

/** Every file under a folder, as raw bytes. */
function everyFile(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) everyFile(p, out); else if (e.isFile()) out.push([p, fs.readFileSync(p)]);
  }
  return out;
}

test("surfaces: the canary comes back from vault.reveal only, never in events, logs, audit, listings or errors", { skip: !mac }, async t => {
  const { root, d, lines, as } = await boot(t);
  const cli = as("cli"), local = as("local"), mcp = as("mcp");
  const pw = canary("pw"), card = canary("card");
  await cli("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: pw, totp: "JBSWY3DPEHPK3PXP" }, url: "https://mail.example.com" });
  await cli("vault.put", { name: "team-card", kind: "card", fields: { number: card, expiry: "01/30" } });

  const outputs = [];
  const keep = r => { outputs.push(JSON.stringify(r)); return r; };
  const s = keep(await local("vault.session.open", { surface: "deck" })).data;
  const shown = await local("vault.reveal", { name: "site-login", session: s.session });
  assert.equal(shown.data.value, pw, "reveal is the one place the value comes back");
  assert.equal((await local("vault.reveal", { name: "team-card" })).data.value, card);
  assert.equal(keep(await local("vault.copy", { name: "site-login", session: s.session })).data.copied, true);
  assert.equal(keep(await local("vault.copy", { name: "team-card" })).data.copied, true);
  assert.match(keep(await local("vault.totp", { name: "site-login", session: s.session })).data.code, /^\d{6}$/);
  assert.equal(keep(await local("vault.fill.native", { name: "site-login", app: { bundle: "com.apple.Safari", pid: 9 } })).data.filled.length, 2);
  keep(await local("vault.fill.native", { name: "site-login", app: { bundle: "com.example.Notes", pid: 9 } }));
  keep(await local("vault.reveal", { name: "site-login", field: "nope" }));
  keep(await local("vault.copy", { name: "site-login", field: "nope" }));
  keep(await mcp("vault.reveal", { name: "site-login" }));
  keep(await mcp("vault.copy", { name: "site-login" }));
  keep(await local("vault.session.status", { session: s.session }));
  keep(await cli("vault.lock"));

  const texts = [
    ...outputs,
    JSON.stringify(d.events.since(0, { limit: 5000 })),
    lines.join("\n"),
    JSON.stringify((await cli("vault.list")).data), JSON.stringify((await mcp("vault.list")).data),
    JSON.stringify((await cli("vault.audit", { limit: 1000 })).data),
    JSON.stringify(await request("GET", "/v1/tools", undefined, { root, caller: "mcp" })),
    JSON.stringify(await request("GET", "/v1/tools", undefined, { root })),
    JSON.stringify(await request("GET", "/v1/events?limit=1000", undefined, { root })),
    await mcpList(root),
  ];
  await d.stop();
  const files = everyFile(root);
  for (const v of [pw, card]) {
    for (const [i, text] of texts.entries()) assert.ok(!text.includes(v), `a value appeared in output ${i}`);
    for (const [file, bytes] of files) assert.ok(!bytes.includes(Buffer.from(v)), `a value appeared in ${path.relative(os.tmpdir(), file)}`);
  }
});

test("surfaces: the Deck and the Capsule reveal behind presence; without a proof nothing is shown", async t => {
  const { d, as } = await boot(t);
  t.after(() => d.stop());
  const pw = canary("pw");
  await as("cli")("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: pw }, url: "https://mail.example.com" });
  for (const who of ["deck", "capsule"]) assert.equal((await as(who)("vault.reveal", { name: "site-login", confirm: true })).data.value, pw);
  const cleared = await as("mcp")("vault.clipboard.clear");
  assert.deepEqual(cleared.data, { cleared: true }, "clearing takes nothing from anyone, so even Claude may");
});

test("surfaces: the Capsule's shape: search gives names only, and actions take { id, front }", async t => {
  const { d, as, clip } = await boot(t);
  t.after(() => d.stop());
  const pw = canary("pw");
  await as("cli")("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: pw, totp: "JBSWY3DPEHPK3PXP" }, url: "https://mail.example.com" });
  const capsule = as("capsule");
  const found = await capsule("vault.search", { q: "mail", limit: 5 });
  assert.deepEqual(found.data.rows, [{ id: "site-login", name: "site-login", kind: "login", sub: "login · mail.example.com" }]);
  assert.deepEqual((await capsule("vault.search", { q: "nothing-like-this" })).data.rows, []);
  assert.match(String((await capsule("vault.totp", { id: "site-login" })).data.code), /^\d{6}$/);
  const copied = await capsule("vault.copy", { id: "site-login", front: { bundle: "com.apple.Safari", pid: 1 } });
  if (mac) assert.match(copied.data.said, /Copied the password of site-login/);
  const filled = await capsule("vault.fill.native", { id: "site-login", front: { bundle: "com.apple.Safari", pid: 4242 } });
  if (mac && filled.data) assert.match(filled.data.said, /^Filled site-login in /);
  assert.match((await capsule("vault.fill.native", { id: "site-login" })).error.message, /which app is in front/);
  assert.ok(!JSON.stringify([found, copied, filled]).includes(pw));
});

test("surfaces: under tests without fakes, copy refuses rather than touch the real clipboard", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input) => call(tool, input, { root, caller: "cli" });
  await cli("vault.put", { name: "api-token", value: canary("t") });
  assert.match((await cli("vault.copy", { name: "api-token" })).error.message, /under tests the clipboard/);
});
