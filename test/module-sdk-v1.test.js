// @ts-check
// Module contract v1 (ADR 0047): object tool entries with reach and outward, the stricter rules for
// an added module, and the capability summary the install card and the capability manifest read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkManifest, toolEntries, capabilities, widened, REACHES } from "../packages/module-sdk/manifest.js";

/** The ADR's example, from the sample world: an added module in v1 shape. */
const bakery = () => ({
  $schema: "https://vyre.run/schema/module-1.json",
  name: "bakery", version: "0.1.0", apiVersion: 1,
  description: "Northwind Bakery's orders, the daily target and the flour order.",
  roles: ["box"],
  does: {
    tools: [
      { name: "bakery.orders", summary: "list today's orders" },
      { name: "bakery.add", summary: "record an order" },
      { name: "bakery.target", summary: "change the daily target", reach: "asked" },
      { name: "bakery.flour", summary: "order flour from the supplier", outward: "pay" },
      { name: "bakery.today", summary: "today's orders against the target" },
    ],
    commands: [{ verb: "orders", tool: "bakery.orders", summary: "today's orders" }],
    watchers: ["watchers/big-order.json"],
  },
  watches: { emits: ["bakery.order-added"], on: ["memory.written"] },
  shows: { deck: ["now:bakery.today"], capsule: { "bakery.orders": { title: "Orders" } } },
  settings: [{ key: "bakery.target", label: "Daily target", type: "int", default: 40, levels: ["account"], apply: "live" }],
  needs: {
    tools: ["memory.write", "push.offer"],
    credentials: [{ id: "supplier", kind: "api-credential", provider: "flourco", purpose: "place flour orders" }],
    network: ["api.flourco.example"],
    connections: [{ provider: "github", purpose: "read the recipe repo" }],
    spend: { dailyUsd: 0.5 },
  },
  teaches: { memory: ["order.habit"] },
});

const edit = (/** @type {(m: any) => void} */ fn, firstParty = false) => { const m = bakery(); fn(m); return checkManifest(m, { firstParty }); };
const has = (/** @type {string[]} */ problems, /** @type {RegExp} */ re) => assert.ok(problems.some(p => re.test(p)), `${re} not in ${JSON.stringify(problems)}`);

test("v1: the ADR's bakery passes as an added module", () => {
  assert.deepEqual(checkManifest(bakery()), []);
  assert.deepEqual(checkManifest(bakery(), { firstParty: true }), []);
});

test("v1: tool entries in either form, named once, and mapped tools find both forms", () => {
  has(edit(m => { m.does.tools.push({ name: "oven.bake" }); }), /tool "oven\.bake" must start with "bakery\."/);
  has(edit(m => { m.does.tools.push("bakery.orders"); }, true), /tool "bakery\.orders" is declared twice/);
  has(edit(m => { m.does.tools.push({ name: "bakery.orders", reach: "asked" }); }), /tool "bakery\.orders" is declared twice/);
  has(edit(m => { m.does.tools.push({ summary: "no name" }); }), /name is required/);
  has(edit(m => { m.does.tools[0].reach = "everyone"; }), /reach must be one of anyone, asked, person, modules, hook/);
  has(edit(m => { m.does.tools[3].outward = "email"; }), /outward must be one of send, post, pay, delete/);
  has(edit(m => { m.does.tools[3].cost = "free"; }), /cost must be "paid"/);
  has(edit(m => { m.does.tools[0].summary = "orders — today"; }), /no em dash or section sign/);
  has(edit(m => { m.does.tools[0].colour = "red"; }), /colour is not a manifest key/);
  assert.deepEqual(edit(m => { m.does.tools[0]["x-note"] = 1; }), []);
  // A string entry and an object entry are both names a command, hook or setting may map to.
  assert.deepEqual(edit(m => { m.does.tools = ["bakery.orders", { name: "bakery.brief" }]; m.does.hooks = { brief: "bakery.brief" }; m.shows = {}; m.settings = []; }, true), []);
  has(edit(m => { m.does.commands[0].tool = "bakery.gone"; }), /does\.commands\[0\] names bakery\.gone, which is not under does\.tools/);
});

test("v1: an added module keeps to the stricter rules, and Vyre's own may not need to", () => {
  has(edit(m => { delete m.apiVersion; }), /apiVersion is required outside Vyre's own modules/);
  has(edit(m => { delete m.description; }), /description is required/);
  has(edit(m => { m.does.tools[0] = "bakery.orders"; }), /tool "bakery\.orders" must be an object like/);
  has(edit(m => { m.does.tools[2].reach = "person"; }), /reach "person" is kept for Vyre's own tools; use "asked"/);
  for (const reach of ["modules", "hook", "person"]) has(edit(m => { m.does.tools[3].reach = reach; }), /an outward tool must have reach "anyone" or "asked"/);
  assert.deepEqual(edit(m => { m.does.tools[3].reach = "asked"; }), []);
  has(edit(m => { m.does.providers = ["oven"]; }), /does\.providers is built in only in 0\.2/);
  has(edit(m => { m.shows.streams = ["live"]; }), /shows\.streams is built in only in 0\.2/);
  has(edit(m => { m.needs.vault = ["bakery-key"]; }), /needs\.vault is built in only in 0\.2/);
  has(edit(m => { m.roles = ["windows"]; }), /loads nowhere in 0\.2/);
  assert.deepEqual(edit(m => { m.roles = ["mac", "windows"]; }), []);
  // Built in: string entries, person reach and the built in only keys stay valid.
  assert.deepEqual(edit(m => {
    delete m.apiVersion; delete m.description;
    m.does.tools[0] = "bakery.orders"; m.does.tools[2].reach = "person";
    m.does.providers = ["oven"]; m.shows.streams = ["live"]; m.needs.vault = ["bakery-key"];
  }, true), []);
});

test("v1: watchers, connections and spend have their shapes", () => {
  has(edit(m => { m.does.watchers = ["/etc/big.json"]; }), /watchers\[0\] must be a relative path to a \.json file inside the module/);
  has(edit(m => { m.does.watchers = ["../other/big.json"]; }), /watchers\[0\] must be a relative path/);
  has(edit(m => { m.does.watchers = ["watchers/big.js"]; }), /watchers\[0\] must be a relative path/);
  has(edit(m => { m.needs.connections = [{ provider: "github" }]; }), /connections\[0\]\.purpose is required/);
  has(edit(m => { m.needs.spend = { dailyUsd: -1 }; }), /dailyUsd must be at least 0/);
  has(edit(m => { m.needs.spend = { usd: 1 }; }), /spend\.dailyUsd is required/);
});

test("v1: toolEntries gives every entry one shape", () => {
  const m = bakery();
  m.does.tools.push(/** @type {any} */ ("bakery.legacy"));
  const rows = toolEntries(m);
  assert.deepEqual(rows.find(r => r.name === "bakery.legacy"), { name: "bakery.legacy", summary: "", reach: "anyone", outward: null, cost: null });
  assert.deepEqual(rows.find(r => r.name === "bakery.flour"), { name: "bakery.flour", summary: "order flour from the supplier", reach: "anyone", outward: "pay", cost: null });
  assert.deepEqual(toolEntries({}), []);
});

test("v1: capabilities are the install card, from the manifest alone", () => {
  const c = capabilities(bakery());
  assert.deepEqual(Object.keys(c.tools).sort(), [...REACHES].sort());
  assert.deepEqual(c.tools.anyone.map(t => t.tool), ["bakery.orders", "bakery.add", "bakery.today"]);
  assert.deepEqual(c.tools.asked, [{ tool: "bakery.target", summary: "change the daily target" }]);
  assert.deepEqual(c.outward, [{ tool: "bakery.flour", kind: "pay", summary: "order flour from the supplier", reach: "anyone" }]);
  assert.deepEqual(c.hosts, ["api.flourco.example"]);
  assert.deepEqual(c.credentials, [{ id: "supplier", kind: "api-credential", provider: "flourco", purpose: "place flour orders" }]);
  assert.deepEqual(c.connections, [{ provider: "github", purpose: "read the recipe repo" }]);
  assert.deepEqual(c.spend, { dailyUsd: 0.5 });
  assert.deepEqual(c.slots, ["now:bakery.today", "command:orders"]);
  assert.deepEqual(c.memory, { kinds: ["order.habit"], writes: true });
  assert.deepEqual(c.runs, ["box"]);
  const bare = capabilities({ name: "kit", version: "0.1.0" });
  assert.deepEqual({ spend: bare.spend, runs: bare.runs, memory: bare.memory, outward: bare.outward }, { spend: null, runs: ["box"], memory: { kinds: [], writes: false }, outward: [] });
});

test("v1: widened names only what an update adds", () => {
  const before = capabilities(bakery());
  assert.deepEqual(widened(before, capabilities(bakery())), []);
  // Narrowing is quiet: a tool, a host and the spend cap taken away.
  assert.deepEqual(widened(before, capabilities({ ...bakery(), needs: { tools: ["memory.write"] } })), []);
  const m = bakery();
  m.does.tools.push({ name: "bakery.post", summary: "post the menu", outward: "post" }, { name: "bakery.clear", summary: "clear the orders", reach: "asked" });
  m.does.tools[0].outward = "send";
  m.needs.network.push("menu.northwind.example");
  m.needs.credentials.push({ id: "social", kind: "oauth", provider: "juno", purpose: "post the menu" });
  m.needs.connections.push({ provider: "kit", purpose: "read notes" });
  m.needs.spend.dailyUsd = 2;
  const w = widened(before, capabilities(m));
  assert.deepEqual(w.map(x => `${x.kind} ${x.what}`), [
    "outward bakery.orders (send)", "outward bakery.post (post)", "host menu.northwind.example",
    "credential social (juno)", "connection kit", "asked bakery.clear", "spend up to $2.00 a day",
  ]);
  assert.deepEqual(w.at(-1), { kind: "spend", what: "up to $2.00 a day", from: 0.5, to: 2 });
});
