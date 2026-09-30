// @ts-check
// The complete example on the real loader (reviews/platform.md CR-H4): examples/modules/bakery in
// a real Registry over a temp home and a temp database, with small fake modules standing in for
// the owners of memory.write, push.offer and vault.request. What the harness promises, the
// registry does: the ctx doors reach their owners as module:bakery, outward is held for a model,
// and a missing owner answers not_available instead of crashing a tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry } from "../core/modules/index.js";
import { open } from "../core/store/index.js";
import { Events } from "../core/events/index.js";
import { tempHome, writeModule } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = path.join(ROOT, "examples", "modules");

/** Fake owners: memory.write, push.offer and vault.request, each recording what reached it. */
function owners(root, { memory = true } = {}) {
  const record = name => `ctx.tool("${name}", { input: { type: "object" }, run: async (input, meta) => { globalThis.__owners.push({ tool: "${name}", input, caller: meta.caller }); return ${name === "push.offer" ? '"sent"' : name === "vault.request" ? "{ status: 201, headers: {}, body: { order: 'fc-1' } }" : "{ id: 'mem-1' }"}; } });`;
  writeModule(root, "memory", { vyre: "1", description: "A stand-in for memory.", does: { tools: memory ? [{ name: "memory.write", reach: "modules" }] : [{ name: "memory.ping" }] } },
    `export default { async start(ctx) { ${memory ? record("memory.write") : 'ctx.tool("memory.ping", { run: async () => 1 });'} return {}; } };`);
  writeModule(root, "push", { vyre: "1", description: "A stand-in for push.", does: { tools: [{ name: "push.offer" }] } }, `export default { async start(ctx) { ${record("push.offer")} return {}; } };`);
  writeModule(root, "vault", { vyre: "1", description: "A stand-in for the vault.", does: { tools: [{ name: "vault.request" }] } }, `export default { async start(ctx) { ${record("vault.request")} return {}; } };`);
}

/** A real Registry with bakery and the fake owners. */
async function world(t, o) {
  const home = tempHome(t);
  const root = path.join(home, "modules");
  owners(root, o);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  /** @type {any[]} */ const seen = [];
  /** @type {any} */ (globalThis).__owners = seen;
  t.after(() => { delete /** @type {any} */ (globalThis).__owners; });
  const reg = new Registry({ db, events: new Events(db), config: {}, log: () => {} });
  await reg.start([...discover([EXAMPLES]), ...discover([root])], { role: "box" });
  t.after(() => reg.stop());
  return { reg, seen };
}

test("bakery on the real registry: orders, add and today work for the person, and the doors reach their owners", async t => {
  const { reg, seen } = await world(t);
  assert.equal(reg.modules.get("bakery").state, "running", reg.modules.get("bakery").error);
  assert.equal((await reg.call("bakery.orders", {}, "cli")).data.count, 0);
  const big = await reg.call("bakery.add", { customer: "Harlow Legal", items: 24 }, "cli");
  assert.equal(big.data && big.data.items, 24, JSON.stringify(big));
  const reached = await reg.call("bakery.add", { customer: "alex", items: 20 }, "cli");
  assert.equal(reached.data.reached, true);
  assert.deepEqual((await reg.call("bakery.today", {}, "deck")).data, { title: "Northwind Bakery", detail: "44 of 40 items today", meta: "2 orders" });
  const mem = seen.filter(s => s.tool === "memory.write");
  assert.equal(mem.length, 2);
  assert.deepEqual({ kind: mem[0].input.kind, from: mem[0].input.from, untrusted: mem[0].input.untrusted, caller: mem[0].caller }, { kind: "note", from: "module:bakery", untrusted: true, caller: "module:bakery" });
  const push = seen.filter(s => s.tool === "push.offer");
  assert.deepEqual(push.map(p => [p.input.kind, p.caller]), [["target-reached", "module:bakery"]]);
});

test("bakery on the real registry: flour from a model is held_unavailable, and from the person it reaches vault.request", async t => {
  const { reg, seen } = await world(t);
  const held = await reg.call("bakery.flour", { kg: 25 }, "mcp:agent:kit");
  assert.equal(held.error.code, "held_unavailable");
  assert.equal(seen.filter(s => s.tool === "vault.request").length, 0, "nothing reached the supplier");
  const r = await reg.call("bakery.flour", { kg: 10 }, "cli");
  assert.equal(r.data.ordered, true, JSON.stringify(r));
  const v = seen.find(s => s.tool === "vault.request");
  assert.deepEqual({ credential: v.input.credential, method: v.input.method, url: v.input.url, caller: v.caller }, { credential: "supplier", method: "POST", url: "https://api.flourco.example/orders", caller: "module:bakery" });
  assert.equal((await reg.call("bakery.target", { target: 50 }, "mcp")).error.code, "not_asked");
});

test("bakery on the real registry: a missing memory.write answers not_available, and bakery.add still works", async t => {
  const { reg, seen } = await world(t, { memory: false });
  const r = await reg.call("bakery.add", { customer: "Harlow Legal", items: 30 }, "cli");
  assert.equal(r.data && r.data.items, 30, JSON.stringify(r));
  assert.equal(seen.filter(s => s.tool === "memory.write").length, 0);
  // The door itself says so, naming the tool.
  const ctx = reg.context(JSON.parse(fs.readFileSync(path.join(EXAMPLES, "bakery", "module.json"), "utf8")));
  assert.deepEqual(await ctx.memory.write({ kind: "note", text: "x" }), { error: { code: "not_available", message: "memory.write isn't running on this Vyre yet" } });
  await assert.rejects(ctx.fetch("https://api.flourco.example/menu"), (/** @type {any} */ e) => e.code === "not_available");
  await assert.rejects(ctx.memory.write({ kind: "fact", text: "x" }), (/** @type {any} */ e) => e.code === "undeclared");
  await assert.rejects(ctx.ask("x", { purpose: "p" }).then(x => { if (x && x.error) throw Object.assign(new Error(x.error.message), { code: x.error.code }); return x; }), (/** @type {any} */ e) => e.code === "not_available");
  await assert.rejects(ctx.gate.request({ kind: "pay", via: "x", to: "y", content: {} }), (/** @type {any} */ e) => e.code === "undeclared");
  assert.deepEqual(await ctx.undo.record({ tool: "bakery.target", input: {}, inverse: { tool: "bakery.target", input: {} } }), { error: { code: "not_available", message: "undo.record isn't running on this Vyre yet" } });
});
