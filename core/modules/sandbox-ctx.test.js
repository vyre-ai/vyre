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
