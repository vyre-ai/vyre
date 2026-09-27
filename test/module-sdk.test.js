// The module API (ADR 0033): every manifest in the repo passes the published schema, the checker
// refuses what it should with a readable reason, and the SDK types name every manifest key and
// every ctx member the loader hands a module.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest, checkSchema, SCHEMA, API_VERSIONS } from "../packages/module-sdk/manifest.js";
import { validate, Registry } from "../core/modules/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK = path.join(ROOT, "packages", "module-sdk");
const DTS = fs.readFileSync(path.join(SDK, "index.d.ts"), "utf8");

/** Every module.json under core, local and modules, one level down (as the loader finds them). */
const manifests = () => ["core", "local", "modules"].flatMap(root => {
  const dir = path.join(ROOT, root);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "module.json")))
    .map(d => ({ file: `${root}/${d.name}/module.json`, m: JSON.parse(fs.readFileSync(path.join(dir, d.name, "module.json"), "utf8")) }));
});

/** A module that uses every key in module API 1, from the sample world. */
const full = () => ({
  $schema: "https://docs.vyre.run/schema/module.json",
  name: "bakery", version: "0.1.0", apiVersion: 1, description: "Northwind Bakery's orders.", main: "index.js",
  roles: ["box"], requires: { projects: ">=0.1" },
  does: {
    tools: ["bakery.orders", "bakery.brief", "bakery.check", "bakery.send", "bakery.order"],
    providers: [],
    hooks: { brief: "bakery.brief", pretool: "bakery.check" },
    senders: { "bakery-fax": "bakery.send" },
    apps: { oven: { app: "Oven", bundleIds: ["com.example.oven"], actions: { order: "bakery.order" } } },
    commands: [{ verb: "orders", tool: "bakery.orders", summary: "today's orders", args: ["day"] }],
  },
  watches: { emits: ["order.placed"], on: ["planner.*", "order.placed"] },
  shows: { deck: ["now:bakery.orders", "renderer:bakery.orders", "settings"], capsule: { "results:bakery.orders": { title: "Orders" } }, cli: ["bakery"], streams: [] },
  settings: [{ key: "bakery.opens", group: "bakery", label: "Opening hour", type: "int", min: 0, max: 23, default: 7, levels: ["account", "project"], apply: "live" }],
  needs: { vault: ["bakery-api-key"], tools: ["planner.*", "memory.answer"], network: ["api.example.com", "*.example.org:8443"], slots: ["now"] },
  teaches: { memory: ["order.habit"], prompt: [{ level: "project", file: "prompt/bakery.md" }] },
  "x-bakery": { anything: true },
});

test("module sdk: every manifest in the repo passes the module API 1 schema", () => {
  const found = manifests();
  assert.ok(found.length >= 30, `found ${found.length} manifests`);
  const problems = found.flatMap(({ file, m }) => checkManifest(m).map(p => `${file}: ${p}`));
  assert.deepEqual(problems, []);
});

test("module sdk: the schema and the loader agree on the repo's manifests", () => {
  for (const { file, m } of manifests()) assert.deepEqual(validate(m), [], file);
});

test("module sdk: a manifest using every module API 1 key passes", () => {
  assert.deepEqual(checkManifest(full()), []);
  assert.deepEqual(API_VERSIONS, [1]);
});

test("module sdk: the checker refuses with a reason a person can act on", () => {
  const bad = (/** @type {(m: any) => void} */ edit) => { const m = full(); edit(m); return checkManifest(m); };
  const has = (/** @type {string[]} */ problems, /** @type {RegExp} */ re) => assert.ok(problems.some(p => re.test(p)), `${re} not in ${JSON.stringify(problems)}`);

  has(bad(m => { m.name = "Bakery"; }), /manifest\.name must be lowercase letters, digits and dashes/);
  has(bad(m => { delete m.version; }), /manifest\.version is required/);
  has(bad(m => { m.apiVersion = 2; }), /apiVersion must be at most 1/);
  has(bad(m => { m.color = "red"; }), /manifest\.color is not a manifest key in module API 1/);
  has(bad(m => { m.does.widgets = []; }), /does\.widgets is not a manifest key/);
  has(bad(m => { m.does.tools.push("oven.bake"); }), /tool "oven\.bake" must start with "bakery\."/);
  has(bad(m => { m.does.tools.push("bakery"); }), /must look like module\.verb/);
  has(bad(m => { m.does.hooks.stop = "bakery.missing"; }), /does\.hooks\.stop names bakery\.missing, which is not under does\.tools/);
  has(bad(m => { m.does.hooks.everything = "bakery.brief"; }), /does\.hooks\.everything is not a manifest key/);
  has(bad(m => { m.does.apps.oven.actions.bake = "bakery.bake"; }), /does\.apps\.oven\.actions\.bake names bakery\.bake/);
  has(bad(m => { m.does.commands[0].tool = "bakery.gone"; }), /does\.commands\[0\] names bakery\.gone, which is not under does\.tools/);
  has(bad(m => { m.does.commands[0].summary = "Today's orders."; }), /must be one lowercase line with no final period/);
  has(bad(m => { m.watches.emits.push("Placed"); }), /must look like noun\.past-verb/);
  has(bad(m => { m.watches.on.push("**"); }), /must be an event type, noun\.\* or \*/);
  has(bad(m => { m.shows.deck.push("sidebar:x"); }), /must be a slot/);
  has(bad(m => { m.settings[0].key = "opens"; }), /must look like module\.key/);
  has(bad(m => { m.settings[0].key = "oven.opens"; }), /setting "oven\.opens" must start with "bakery\."/);
  has(bad(m => { m.settings[0].levels = []; }), /levels needs at least 1/);
  has(bad(m => { m.settings[0].apply = "never"; }), /apply must be one of live, session, restart/);
  has(bad(m => { m.replaces = "memory"; }), /a replacement takes the name of the module it replaces/);
  has(bad(m => { m.teaches.prompt[0].file = "/etc/passwd"; }), /must be a relative path to a \.md file/);
  has(bad(m => { m.roles = ["cloud"]; }), /roles\[0\] must be one of box, local/);
  has(bad(m => { m.requires = "projects"; }), /requires must be/);
  assert.deepEqual(bad(m => { m.name = "memory"; m.replaces = "memory"; m.does = { tools: ["memory.answer"] }; m.settings = []; }), []);
});

test("module sdk: checkSchema follows local refs and reports the closest anyOf branch", () => {
  const schema = { $defs: { n: { type: "integer", minimum: 1 } }, anyOf: [{ $ref: "#/$defs/n" }, { type: "string", pattern: "^v" }] };
  assert.deepEqual(checkSchema(schema, 3), []);
  assert.deepEqual(checkSchema(schema, "v2"), []);
  assert.deepEqual(checkSchema(schema, 0), ["manifest must be at least 1"]);
  assert.throws(() => checkSchema({ $ref: "other.json#/x" }, 1), /only local refs/);
});

test("module sdk: the types name every manifest key in the schema", () => {
  const manifestType = DTS.slice(DTS.indexOf("export interface Manifest {"), DTS.indexOf("// ---- Tools"));
  const keys = [];
  for (const [k, s] of Object.entries(SCHEMA.properties)) {
    keys.push(k);
    if (s.properties) for (const sub of Object.keys(s.properties)) keys.push(`${k}.${sub}`);
  }
  const missing = keys.filter(k => {
    const [top, sub] = k.split(".");
    const at = manifestType.search(new RegExp(`\\n  ${top.replace("$", "\\$")}\\??:`));
    if (at < 0) return true;
    return sub ? !new RegExp(`\\n    ${sub}\\??:`).test(manifestType.slice(at, manifestType.indexOf("\n  }", at) + 4)) : false;
  });
  assert.deepEqual(missing, []);
});

test("module sdk: the types name every ctx member the loader hands a module", () => {
  const ctx = new Registry({ log() {}, config: {}, paths: {}, events: {}, db: null }).context({ name: "bakery" });
  const ctxType = DTS.slice(DTS.indexOf("export interface ModuleContext {"), DTS.indexOf("export interface Module {"));
  const missing = Object.keys(ctx).filter(k => !new RegExp(`\\n  (readonly )?${k}[(<?:]`).test(ctxType));
  assert.deepEqual(missing, []);
  const eventsType = DTS.slice(DTS.indexOf("export interface ModuleEvents {"), DTS.indexOf("// ---- The context"));
  assert.deepEqual(Object.keys(ctx.events).filter(k => !new RegExp(`\\n  ${k}[(<]`).test(eventsType)), []);
});

test("module sdk: the package ships only what it names, and its schema is the one the docs link", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SDK, "package.json"), "utf8"));
  for (const f of pkg.files) assert.ok(fs.existsSync(path.join(SDK, f)), f);
  assert.equal(pkg.types, "index.d.ts");
  assert.equal(SCHEMA.$id, "https://docs.vyre.run/schema/module.json");
});
