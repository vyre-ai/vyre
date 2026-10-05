// @ts-check
// An added module written against the SDK (`export default { start(ctx) }`) runs the same contract in the sandbox: its tools, its own database (async exec/query/migrate, never ctx.store.db),
// ctx.call held to needs.tools, ctx.events.emit held to watches.emits, and nothing that is not a door of module API 1. Linux only: the sandbox needs bubblewrap.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";

const SOURCE = `export default { async start(ctx) {
  await ctx.store.migrate(["CREATE TABLE bakery_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL)"]);
  ctx.tool("bakery.add", { input: { type: "object" }, run: async ({ customer }) => {
    await ctx.store.exec("INSERT INTO bakery_orders (customer) VALUES (?)", [customer]);
    await ctx.events.emit("bakery.order-added", { customer: "(not stored in the event)" });
    const rows = await ctx.store.query("SELECT COUNT(*) AS n FROM bakery_orders");
    return { n: rows[0].n, name: ctx.name, hasDb: typeof ctx.store.db };
  } });
  ctx.tool("bakery.probe", { input: { type: "object" }, run: async () => {
    const out = {};
    for (const [k, f] of Object.entries({
      echo: () => ctx.call("system.echo", { text: "hi" }),
      vault: () => ctx.call("vault.list", {}),
      emit: () => ctx.events.emit("bakery.something-else", {}),
      fetchPrivate: () => ctx.vault.fetch("x"),
      prune: () => ctx.events.prune({ type: "bakery.order-added", before: 1 }),
      route: () => ctx.route("GET", "/x", () => ({})),
    })) { try { const r = await f(); out[k] = { ok: true, r: r && (r.data || r) }; } catch (e) { out[k] = { code: e.code, message: String(e.message).slice(0, 80) }; } }
    return out;
  } });
  return {};
} };`;

test("a sandboxed SDK module: its tools run, its own database works, and every door is held to its declaration", { skip: process.platform !== "linux" ? "the added-module sandbox needs bwrap (linux)" : false, timeout: 90_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  writeModule(path.join(root, "modules"), "bakery", { vyre: "1", description: "A bakery's orders.",
    does: { tools: [{ name: "bakery.add", reach: "anyone" }, { name: "bakery.probe", reach: "anyone" }] },
    needs: { tools: ["system.echo"] }, watches: { emits: ["bakery.order-added"] } }, SOURCE);
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  assert.equal(d.registry.status().find(m => m.name === "bakery")?.state, "running", JSON.stringify(d.registry.status().find(m => m.name === "bakery")));
  const a1 = await d.registry.call("bakery.add", { customer: "Harlow Legal" }, "local");
  assert.deepEqual(a1.data, { n: 1, name: "bakery", hasDb: "undefined" }, JSON.stringify(a1));
  assert.equal((await d.registry.call("bakery.add", { customer: "Northwind" }, "local")).data.n, 2, "the table and its rows are the module's own and persist");
  assert.ok(d.events.since(0, { type: "bakery.order-added" }).length >= 2, "its declared event reached the log");
  const p = (await d.registry.call("bakery.probe", {}, "local")).data;
  assert.equal(p.echo.ok, true, JSON.stringify(p.echo));
  for (const k of ["vault", "emit", "fetchPrivate", "prune", "route"]) assert.ok(p[k] && p[k].ok !== true && p[k].code, `${k} is refused: ${JSON.stringify(p[k])}`);
  assert.equal(p.vault.code, "undeclared", "ctx.call to a tool not in needs.tools");
  assert.equal(p.fetchPrivate.code, "undeclared", "ctx.vault.fetch is built in, not a door");
  assert.ok(fs.existsSync(path.join(root, "data", "bakery", "module.db")), "its own file in its own folder");
});

const FORMS = `export default { async start(ctx) {
  ctx.tool("forms.submit", { input: { type: "object" }, run: async ({ name, email, other }) => {
    const made = await ctx.kernel.records.create("lead", { name, email });
    let blocked = null;
    try { await ctx.kernel.records.create(other || "contact", { name }); } catch (e) { blocked = e.code; }
    const page = await ctx.kernel.records.list("lead", { limit: 10 });
    let defines = null, handle = null;
    try { await ctx.kernel.records.define({ add_types: [] }); } catch (e) { defines = e.code; }
    try { await ctx.kernel.gateway.records.define({}); } catch (e) { handle = e.code; }
    return { urn: made.urn, count: page.rows.length, blocked, defines, handle };
  } });
  return {};
} };`;

test("needs.kernel.records: a sandboxed module makes and lists records of the types it declared, under the person who installed it, and nothing else", { skip: process.platform !== "linux" ? "the added-module sandbox needs bwrap (linux)" : false, timeout: 90_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  writeModule(path.join(root, "modules"), "forms", { vyre: "1", description: "A public form that files a lead.",
    does: { tools: [{ name: "forms.submit", reach: "anyone" }] }, needs: { kernel: { records: ["lead"] } } }, FORMS);
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  assert.equal(d.registry.status().find(m => m.name === "forms")?.state, "running", JSON.stringify(d.registry.status().find(m => m.name === "forms")));
  // The Space has a `lead` type (a person defined it); the module cannot define one.
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(owner, { add_types: [{ name: "lead", label: "Lead", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "email", kind: "text", label: "Email" }] }, { name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }] }] });
  const r = await d.registry.call("forms.submit", { name: "Dana", email: "dana@harlow.test" }, "local");
  assert.ok(r.data, JSON.stringify(r));
  assert.match(r.data.urn, /\/lead\//);
  assert.equal(r.data.count, 1);
  assert.equal(r.data.blocked, "undeclared", "a type it did not declare is refused");
  assert.equal(r.data.defines, "undeclared", "it cannot define types");
  assert.equal(r.data.handle, "undeclared", "it has no kernel handle");
});

test("a module tool marked flow is an action of the Space the owner may run from a Flow, and a Flow's call step runs it; a tool not marked is not reachable that way", { skip: process.platform !== "linux" ? "the added-module sandbox needs bwrap (linux)" : false, timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  writeModule(path.join(root, "modules"), "stamp", { vyre: "1", description: "Stamps a note with a counter.",
    does: { tools: [{ name: "stamp.mark", reach: "anyone", summary: "stamp a note", flow: { risk: "write", label: "Stamp the note" } }, { name: "stamp.peek", reach: "anyone", summary: "read the counter" }] }, watches: { emits: ["stamp.marked"] } },
    `export default { async start(ctx) {
      await ctx.store.migrate(["CREATE TABLE stamp_marks (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)"]);
      ctx.tool("stamp.mark", { input: { type: "object" }, run: async ({ note }) => { await ctx.store.exec("INSERT INTO stamp_marks (note) VALUES (?)", [String(note || "")]); await ctx.events.emit("stamp.marked", {}); return { ok: true }; } });
      ctx.tool("stamp.peek", { input: { type: "object" }, run: async () => ({ n: (await ctx.store.query("SELECT COUNT(*) AS n FROM stamp_marks"))[0].n }) });
      return {};
    } };`);
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  assert.equal(d.registry.status().find(m => m.name === "stamp")?.state, "running", JSON.stringify(d.registry.status().find(m => m.name === "stamp")));
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const names = d.kernel.gateway.actions().map((/** @type {any} */ a) => a.action);
  assert.ok(names.includes("stamp.mark") && !names.includes("stamp.peek"), "only the marked tool is an action");
  const res = `vyre://${d.kernel.id.space}/module/stamp/mark`;
  assert.equal((await d.kernel.gateway.authorize({ chain: owner, action: "stamp.mark", resource: res })).effect, "allow", "the owner holds it");
  const agent = d.kernel.chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s9", thread: "t9", vouched: true, person: d.kernel.id.owner });
  assert.notEqual((await d.kernel.gateway.authorize({ chain: agent, action: "stamp.mark", resource: res })).effect, "allow", "an assistant does not");
  // A Flow with a call step runs it.
  const host = d.registry.deps.flowsHost.get(d.kernel.id.space);
  const meta = async () => ({ token: (await d.kernel.surfaces.open(owner, {})).token });
  const flow = { format: 1, name: "stamp_it", label: "Stamp it", authorship: "human", trigger: { on: "manual" },
    caps: [{ action: "stamp.mark", resource: `vyre://${d.kernel.id.space}/module/stamp/*` }],
    steps: [{ id: "s", kind: "call", action: "stamp.mark", resource: res, input: { note: "from a flow" } }] };
  const def = await d.registry.call("flows.define", { flow }, "cli", await meta());
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.data.id, version: def.data.version, hash: def.data.hash });
  await host.flows.tools["flows.start"](host.personChain(), { id: def.data.id, input: {} });
  let n = 0; for (let i = 0; i < 60 && n < 1; i++) { await new Promise(r => setTimeout(r, 250)); n = (await d.registry.call("stamp.peek", {}, "local")).data.n; }
  assert.equal(n, 1, "the Flow's call step ran the module's tool once");
  // A tool that was not marked is no action a Flow may name.
  assert.ok(!d.registry.flowActionTools.has("stamp.peek"));
});
