// @ts-check
// @vyre/module-sdk/testing (ADR 0047 section 7): the fake registry routes calls by reach and
// outward exactly as section 2 says, holds the module to its manifest, and leaves nothing behind.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestContext, testModule } from "../packages/module-sdk/testing.js";

const manifest = () => ({
  name: "kit", version: "0.1.0", apiVersion: 1, description: "Kit's notes for juno.",
  does: { tools: [
    { name: "kit.read", summary: "read a note" },
    { name: "kit.clear", summary: "clear the notes", reach: "asked" },
    { name: "kit.mail", summary: "mail a note", outward: "send" },
    { name: "kit.inner", summary: "for other modules", reach: "modules" },
    { name: "kit.hook", summary: "the webhook", reach: "hook" },
    { name: "kit.own", summary: "Vyre's own", reach: "person" },
  ] },
  watches: { emits: ["kit.noted"], on: ["memory.*"] },
  shows: { notices: ["kit-due"] },
  teaches: { memory: ["note"] },
  settings: [
    { key: "kit.size", label: "Size", type: "int", default: 3, levels: ["account"], apply: "live" },
    { key: "kit.open", label: "Open", type: "bool", levels: ["account"], apply: "live", confirm: true },
  ],
  needs: {
    tools: ["planner.*", "gate.request"],
    credentials: [{ id: "mailer", kind: "api-credential", provider: "juno", purpose: "send mail" }],
    network: ["api.juno.example", "*.kit.example:8443"],
    spend: { dailyUsd: 0.1 },
  },
});

/** A harness with every tool registered to record how it ran. */
function world(t, opts = {}) {
  const h = createTestContext(manifest(), opts);
  t.after(() => h.stop());
  /** @type {any[]} */
  const ran = [];
  for (const e of manifest().does.tools) h.ctx.tool(/** @type {any} */ (e.name), { input: { type: "object" }, run: (input, meta) => { ran.push({ tool: e.name, input, meta }); return { ok: true }; } });
  return { h, ran };
}

test("testing: reach decides who may call, as ADR 0047 section 2 says", async t => {
  const { h, ran } = world(t);
  assert.deepEqual(await h.call("kit.read", {}, { who: "agent" }), { data: { ok: true } });
  assert.equal((await h.call("kit.clear", {}, { who: "agent" })).error.code, "not_asked");
  assert.deepEqual(await h.call("kit.clear", {}, { who: "agent", asked: true }), { data: { ok: true } });
  assert.deepEqual(await h.call("kit.clear", {}), { data: { ok: true } });
  assert.equal((await h.call("kit.clear", {}, { who: "module" })).error.code, "denied");
  assert.equal((await h.call("kit.inner", {}, { who: "agent" })).error.code, "no_such_tool");
  assert.equal((await h.call("kit.inner", {}, { who: "person" })).error.code, "no_such_tool");
  assert.deepEqual(await h.call("kit.inner", {}, { who: "module" }), { data: { ok: true } });
  assert.equal((await h.call("kit.hook", {}, { who: "person" })).error.code, "no_such_tool");
  assert.deepEqual(await h.call("kit.hook", {}, { who: "hook" }), { data: { ok: true } });
  assert.equal((await h.call("kit.read", {}, { who: "hook" })).error.code, "no_such_tool");
  assert.equal((await h.call("kit.own", {}, { who: "agent" })).error.code, "person_only");
  assert.equal((await h.call("kit.nothing", {})).error.code, "no_such_tool");
  const agentRun = ran.find(r => r.tool === "kit.clear" && r.meta.who === "agent");
  assert.deepEqual(agentRun.meta, { caller: "mcp:agent:kit", who: "agent", agent: "kit", asked: true });
});

test("testing: an outward tool is held for anyone but the person, and runs once approved", async t => {
  const { h, ran } = world(t);
  const held = await h.call("kit.mail", { to: "alex" }, { who: "agent" });
  assert.deepEqual(held, { held: "hold-1" });
  assert.equal(ran.length, 0, "a held call never runs");
  assert.deepEqual(h.holds, [{ id: "hold-1", kind: "send", via: "kit.mail", content: { to: "alex" }, who: "agent", state: "held" }]);
  assert.ok("held" in await h.call("kit.mail", {}, { who: "module" }));
  assert.equal((await h.call("kit.mail", {}, { who: "hook" })).error.code, "no_such_tool", "the webhook reaches only hook tools");
  await h.call("kit.mail", { to: "alex" });
  assert.equal(ran.at(-1).meta.gate, "person");
  await h.call("kit.mail", { to: "juno" }, { who: "agent", asked: true });
  assert.equal(ran.at(-1).meta.gate, "asked");
  // The person edits the held content, and it runs once as module:gate.
  const r = await h.approve("hold-1", { to: "alex", text: "edited" });
  assert.deepEqual(r, { data: { ok: true } });
  assert.deepEqual({ caller: ran.at(-1).meta.caller, gate: ran.at(-1).meta.gate, input: ran.at(-1).input }, { caller: "module:gate", gate: "approved", input: { to: "alex", text: "edited" } });
  assert.equal((await h.approve("hold-1")).error.code, "not_found", "a hold runs once");
});

test("testing: the module is held to its manifest", async t => {
  const { h } = world(t);
  const { ctx } = h;
  assert.throws(() => ctx.tool(/** @type {any} */ ("kit.extra"), { run: () => 1 }), /does not declare under does\.tools/);
  assert.throws(() => ctx.tool("kit.read", { run: () => 1 }), /already registered/);
  assert.throws(() => ctx.events.emit("kit.gone", {}), /does not declare under watches\.emits/);
  assert.throws(() => ctx.events.on("planner.*", () => {}), /does not declare under watches\.on/);
  const got = [];
  ctx.events.on("memory.written", e => got.push(e.type));
  h.deliver("memory.written", { id: 1 });
  ctx.events.emit("kit.noted", { n: 1 });
  assert.deepEqual(got, ["memory.written"]);
  assert.deepEqual(ctx.events.since(1).map(e => e.type), ["kit.noted"]);
  assert.equal(ctx.events.latestId(), 2);
  const undeclared = (/** @type {RegExp} */ re) => (/** @type {any} */ e) => e.code === "undeclared" && re.test(e.message);
  await assert.rejects(ctx.call("threads.answer", {}), undeclared(/needs\.tools does not list/));
  assert.equal((await ctx.call("planner.list", {})).error.code, "no_such_tool", "declared, but no fake answers it");
  assert.equal((await ctx.memory.write({ kind: "note", text: "Northwind Bakery wants rye" })).data.id, "mem-1");
  assert.deepEqual(h.memory, [{ kind: "note", text: "Northwind Bakery wants rye", from: "module:kit", untrusted: true }]);
  await assert.rejects(ctx.memory.write({ kind: "fact", text: "juno reads on Sundays" }), undeclared(/teaches\.memory does not list/));
  assert.equal(await ctx.push.offer({ title: "Due", body: "a note is due", kind: "kit-due" }), "sent");
  await assert.rejects(ctx.push.offer({ title: "x", body: "y", kind: "info" }), undeclared(/shows\.notices does not list/));
  assert.ok("held" in await ctx.gate.request({ kind: "send", via: "mail.send", content: { to: "alex" } }));
  assert.throws(() => ctx.events.emit("kit.gone", {}), undeclared(/watches\.emits/));
  assert.throws(() => ctx.route("x", () => {}), /built in only/);
  assert.ok(h.violations.length >= 6, h.violations.join("\n"));
});

test("testing: each ctx door needs its one declaration, and undo needs none", async t => {
  const h = createTestContext({ name: "kit", version: "0.1.0", apiVersion: 1, description: "Kit.", does: { tools: [{ name: "kit.read" }] } });
  t.after(() => h.stop());
  const { ctx } = h;
  const undeclared = (/** @type {RegExp} */ re) => (/** @type {any} */ e) => e.code === "undeclared" && re.test(e.message);
  await assert.rejects(ctx.gate.request({ kind: "send", via: "mail.send", content: {} }), undeclared(/gate\.request/));
  await assert.rejects(ctx.vault.request("mailer", { method: "GET", url: "https://api.juno.example/" }), undeclared(/needs\.credentials/));
  await assert.rejects(ctx.connections.call("github", "issues.list", {}), undeclared(/needs\.connections/));
  await assert.rejects(ctx.fetch("https://api.juno.example/"), undeclared(/needs\.network/));
  await assert.rejects(ctx.memory.write({ kind: "note", text: "x" }), undeclared(/teaches\.memory/));
  await assert.rejects(ctx.ask("x", { purpose: "p" }), undeclared(/needs\.spend/));
  await assert.rejects(ctx.spend.record({ usd: 0.01, purpose: "p" }), undeclared(/needs\.spend/));
  await assert.rejects(ctx.spend.check("p"), undeclared(/needs\.spend/));
  await assert.rejects(ctx.push.offer({ title: "x", body: "y", kind: "due" }), undeclared(/shows\.notices/));
  await ctx.undo.record({ tool: "kit.read", input: {}, inverse: { tool: "kit.read", input: {} } });
  assert.deepEqual(h.calls.map(c => c.member), ["undo.record"]);
});

test("testing: settings, vault, fetch, ask and spend", async t => {
  const { h } = world(t, { vault: { mailer: { status: 202, headers: {}, body: { queued: true } } }, fetch: () => ({ body: { rye: 3 } }), ask: () => ({ text: "rye", usd: 0.08 }) });
  const { ctx } = h;
  assert.equal(await ctx.settings.get("kit.size"), 3);
  const seen = [];
  ctx.settings.on("kit.size", v => seen.push(v));
  await ctx.settings.set("kit.size", 5);
  assert.equal(await ctx.settings.get("kit.size"), 5);
  assert.deepEqual(seen, [5]);
  await assert.rejects(ctx.settings.set("kit.open", true), /asks the person/);
  await assert.rejects(ctx.settings.get("kit.other"), /does not declare/);

  assert.deepEqual(await ctx.vault.request("mailer", { method: "GET", url: "https://api.juno.example/me" }), { status: 202, headers: {}, body: { queued: true } });
  const w = await ctx.vault.request("mailer", { method: "POST", url: "https://api.juno.example/send", body: { to: "alex" } });
  assert.ok("held" in w, "a write outside a cleared call holds at the Gate");
  await assert.rejects(ctx.vault.request("other", { method: "GET", url: "https://x.example" }), /needs\.credentials/);

  assert.deepEqual(await (await ctx.fetch("https://api.juno.example/menu")).json(), { rye: 3 });
  assert.equal((await ctx.fetch("https://notes.kit.example:8443/x")).status, 200);
  await assert.rejects(ctx.fetch("https://notes.kit.example/x"), /needs\.network/, "the port is part of the entry");
  await assert.rejects(ctx.fetch("https://evil.example/"), /needs\.network/);
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/", "http://100.100.1.1/", "http://box.tail1234.ts.net/", "http://10.0.0.2/"]) {
    await assert.rejects(ctx.fetch(u), /private address/, u);
  }

  assert.deepEqual(await ctx.ask("what bread?", { purpose: "suggest" }), { text: "rye", usd: 0.08 });
  await ctx.spend.record({ usd: 0.03, purpose: "suggest" });
  assert.deepEqual(await ctx.spend.check("suggest"), { ok: false, spentUsd: 0.11, capUsd: 0.1 });
  assert.equal((await ctx.ask("again?", { purpose: "suggest" })).error.code, "capped");
  await ctx.undo.record({ tool: "kit.clear", input: {}, inverse: { tool: "kit.read", input: {} } });
  assert.deepEqual(h.calls.map(c => c.member), ["vault.request", "vault.request", "fetch", "fetch", "ask", "spend.record", "spend.check", "ask", "undo.record"]);
});

test("testing: migrations run forward only, once, in the module's own tables", async t => {
  const h = createTestContext(manifest());
  const steps = ["CREATE TABLE kit_notes (id INTEGER PRIMARY KEY, text TEXT)", "ALTER TABLE kit_notes ADD COLUMN at INTEGER"];
  h.ctx.store.migrate(steps);
  h.ctx.store.migrate(steps);
  assert.deepEqual(h.ctx.store.db.prepare("SELECT name FROM pragma_table_info('kit_notes')").all().map(r => r.name), ["id", "text", "at"]);
  assert.throws(() => h.ctx.store.migrate(steps.slice(0, 1)), /forward only/);
  assert.throws(() => h.ctx.store.migrate([...steps, "CREATE TABLE notes (id INTEGER)"]), /must start with "kit_"/);
  assert.ok(fs.existsSync(path.join(h.ctx.paths.data, "store.db")));
  assert.ok(h.dir.startsWith(os.tmpdir()));
  await h.stop();
  assert.ok(!fs.existsSync(h.dir), "the temp home is gone");
});

test("testing: testModule starts a module folder and stops it", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sdk-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "module.json"), JSON.stringify(manifest()));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(root, "index.js"), `let stopped = 0;
export default { async start(ctx) {
  ctx.tool("kit.read", { input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } }, run: ({ id }) => ({ id, size: 3 }) });
  return { async stop() { stopped++; globalThis.__kitStopped = stopped; } };
} };
`);
  const h = await testModule(root);
  assert.deepEqual(await h.call("kit.read", { id: 7 }), { data: { id: 7, size: 3 } });
  assert.equal((await h.call("kit.read", { id: "7" })).error.code, "bad_input");
  assert.equal((await h.call("kit.read", {})).error.message, "input.id is required");
  await h.stop();
  assert.equal(/** @type {any} */ (globalThis).__kitStopped, 1);
  assert.ok(!fs.existsSync(h.dir));
});
