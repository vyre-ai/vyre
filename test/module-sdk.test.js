// The module API (ADR 0033): every manifest in the repo passes the published schema, the checker
// refuses what it should with a readable reason, and the SDK types name every manifest key and
// every ctx member the loader hands a module.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest, checkManifestFull, checkSchema, SCHEMA, API_VERSIONS, flowSteps, flowTriggers, capabilities } from "../packages/module-sdk/manifest.js";
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
  $schema: "https://vyre.run/schema/module-1.json",
  name: "bakery", version: "0.1.0", apiVersion: 1, description: "Northwind Bakery's orders.", main: "index.js",
  roles: ["box"], requires: { projects: ">=0.1" },
  does: {
    tools: ["bakery.orders", "bakery.brief", "bakery.check", "bakery.send", "bakery.order"],
    providers: [],
    hooks: { brief: "bakery.brief", pretool: "bakery.check" },
    senders: { "bakery-fax": "bakery.send" },
    apps: { oven: { app: "Oven", bundleIds: ["com.example.oven"], actions: { order: "bakery.order" } } },
    commands: [{ verb: "orders", tool: "bakery.orders", summary: "today's orders", args: ["day"] }],
    connections: "bakery.orders",
    suggest: "bakery.orders",
  },
  watches: { emits: ["order.placed"], on: ["planner.*", "order.placed"] },
  shows: { deck: ["now:bakery.orders", "renderer:bakery.orders", "settings"], capsule: { "results:bakery.orders": { title: "Orders" } }, cli: ["bakery"], streams: [], notices: ["order-late"] },
  settings: [
    { key: "bakery.opens", group: "bakery", label: "Opening hour", type: "int", min: 0, max: 23, default: 7, levels: ["account", "project"], apply: "live" },
    { key: "bakery.fax", label: "Fax orders", type: "bool", levels: ["account"], apply: "live", security: "loosens", loosens: "outbound fax", confirm: { values: [true] }, store: { config: "bakery.fax" } },
    { key: "bakery.oven", label: "Oven", type: "string", levels: ["project"], apply: "session", confirm: true, store: { tool: { get: { tool: "bakery.orders", input: { project: "$project" }, read: "oven" }, set: { tool: "bakery.order", input: { oven: "$value" } } } } },
    { key: "bakery.model", label: "Model", type: "model", levels: ["account"], apply: "session", secret: false },
    { key: "bakery.look", label: "Look", type: "enum", levels: ["account", "device"], apply: "live", choicesFrom: { tool: "bakery.orders" }, check: { tool: "bakery.check" } },
  ],
  needs: { vault: ["bakery-api-key"], tools: ["planner.*", "memory.answer"], network: ["api.example.com", "*.example.org:8443"], slots: ["now"],
    credentials: [{ id: "till", kind: "api-key", provider: "northwind-till", purpose: "read today's orders", optional: true, multiple: false }] },
  teaches: { memory: ["order.habit"], prompt: [{ level: "project", file: "prompt/bakery.md" }],
    tips: [{ id: "orders-today", text: "Type vyre bakery orders to see today's orders.", surfaces: ["cli", "capsule", "statusline"], level: "discovery",
      trigger: "never-used", since: "0.1.0", command: "vyre bakery orders", docs: "using/cli.md#orders", about: "cli" }] },
  "x-bakery": { anything: true },
});

test("module sdk: every manifest in the repo passes the module API 1 schema", () => {
  const found = manifests();
  assert.ok(found.length >= 30, `found ${found.length} manifests`);
  const problems = found.flatMap(({ file, m }) => checkManifest(m, { firstParty: true }).map(p => `${file}: ${p}`));
  assert.deepEqual(problems, []);
});

test("module sdk: the schema and the loader agree on the repo's manifests", () => {
  for (const { file, m } of manifests()) assert.deepEqual(validate(m, { firstParty: true }), [], file);
});

test("module sdk: a manifest using every module API 1 key passes as one of Vyre's own", () => {
  // providers, streams, needs.vault and string tool entries are built in only (ADR 0047);
  // test/module-sdk-v1.test.js holds an added module to the rest.
  assert.deepEqual(checkManifest(full(), { firstParty: true }), []);
  assert.deepEqual(API_VERSIONS, [1]);
});

test("module sdk: the checker refuses with a reason a person can act on", () => {
  const bad = (/** @type {(m: any) => void} */ edit, firstParty = true) => { const m = full(); edit(m); return checkManifest(m, { firstParty }); };
  const has = (/** @type {string[]} */ problems, /** @type {RegExp} */ re) => assert.ok(problems.some(p => re.test(p)), `${re} not in ${JSON.stringify(problems)}`);

  has(bad(m => { m.name = "Bakery"; }), /manifest\.name must be lowercase letters, digits and dashes/);
  has(bad(m => { delete m.version; }), /manifest\.version is required/);
  has(bad(m => { m.apiVersion = 2; }), /bakery needs a newer Vyre \(module contract 2\); this Vyre has 1\.0/);
  // Unknown keys are warnings, never problems: a typo, or a key from a newer contract (ADR 0047 section 8).
  const warned = (/** @type {(m: any) => void} */ e) => { const m = full(); e(m); return checkManifestFull(m, { firstParty: true }); };
  for (const [e, re] of /** @type {[(m: any) => void, RegExp][]} */ ([[m => { m.color = "red"; }, /manifest\.color is not a key in module contract 1\.0; it is ignored/],
    [m => { m.does.widgets = []; }, /does\.widgets is not a key/], [m => { m.does.hooks.everything = "bakery.brief"; }, /does\.hooks\.everything is not a key/]])) {
    const r = warned(e);
    assert.deepEqual(r.problems, []);
    has(r.warnings, re);
  }
  has(bad(m => { m.does.tools.push("oven.bake"); }), /tool "oven\.bake" must start with "bakery\."/);
  has(bad(m => { m.does.tools.push("bakery"); }), /must look like module\.verb/);
  has(bad(m => { m.does.hooks.stop = "bakery.missing"; }), /does\.hooks\.stop names bakery\.missing, which is not under does\.tools/);
  has(bad(m => { m.does.apps.oven.actions.bake = "bakery.bake"; }), /does\.apps\.oven\.actions\.bake names bakery\.bake/);
  has(bad(m => { m.does.commands[0].tool = "bakery.gone"; }), /does\.commands\[0\] names bakery\.gone, which is not under does\.tools/);
  has(bad(m => { m.does.commands[0].summary = "Today's orders."; }), /must be one lowercase line with no final period/);
  has(bad(m => { m.watches.emits.push("Placed"); }), /must look like noun\.past-verb/);
  has(bad(m => { m.watches.on.push("**"); }), /must be an event type, noun\.\* or \*/);
  has(bad(m => { m.shows.deck.push("sidebar:x"); }), /must be a slot/);
  has(bad(m => { m.settings[0].key = "opens"; }), /must look like module\.key/);
  has(bad(m => { m.settings[0].key = "oven.opens"; }), /setting "oven\.opens" must start with "bakery\."/);
  has(bad(m => { m.settings[0].levels = []; }), /levels needs at least 1/);
  has(bad(m => { m.settings[1].levels = ["project"]; }), /a config\.json setting is account only/);
  has(bad(m => { m.settings[3].key = "bakery.opens"; }), /setting bakery\.opens is declared twice/);
  has(bad(m => { m.settings[1].store = { config: "a", claude: "b" }; }), /store/);
  has(bad(m => { m.settings[2].store.tool.set = {}; }), /set\.tool is required/);
  has(bad(m => { m.settings[0].security = "tightens"; }), /security must be one of loosens/);
  has(bad(m => { m.settings[3].store = { claude: "permissions.allow" }; }, false), /only Vyre's own modules may keep a setting in Claude Code's files/);
  has(bad(m => { m.settings[1].store = { config: "gate.approvers" }; }, false), /a config\.json path must start with "bakery\."/);
  has(bad(m => { m.settings[2].store.tool.set.tool = "threads.answer"; }, false), /store\.tool\.set must be one of this module's own tools/);
  assert.deepEqual(checkManifest({ ...full(), settings: [{ key: "bakery.model", label: "Model", type: "model", levels: ["account"], apply: "session", store: { claude: "model" } }] }, { firstParty: true }), []);
  has(bad(m => { m.settings[0].apply = "never"; }), /apply must be one of live, session, restart/);
  has(bad(m => { m.replaces = "memory"; }), /a replacement takes the name of the module it replaces/);
  has(bad(m => { m.teaches.prompt[0].file = "/etc/passwd"; }), /must be a relative path to a \.md file/);
  has(bad(m => { m.settings[4].check.tool = "theme.check"; }), /setting bakery\.look: check\.tool must be one of this module's own tools/);
  has(bad(m => { m.settings[4].choicesFrom = { tool: "bakery.gone" }; }), /choicesFrom\.tool must be one of this module's own tools/);
  has(bad(m => { m.settings[4].choices = { tool: "bakery.orders" }; }), /choices must be array/);
  has(bad(m => { m.settings[0].levels = ["account", "session"]; }), /the session level needs a store in this module's own tools/);
  assert.deepEqual(bad(m => { m.settings[2].levels = ["project", "session"]; }), []);
  has(bad(m => { m.settings[1].levels = ["account", "device"]; delete m.settings[1].store; }), /may not be set per device/);
  has(bad(m => { m.settings[0].levels = ["galaxy"]; }), /levels\[0\] must be one of account, project, device, session/);
  has(bad(m => { m.needs.credentials[0].id = "Till"; }), /credentials\[0\]\.id must be a lowercase name/);
  has(bad(m => { delete m.needs.credentials[0].purpose; }), /credentials\[0\]\.purpose is required/);
  has(bad(m => { m.does.connections = "bakery.gone"; }), /does\.connections names bakery\.gone, which is not under does\.tools/);
  has(bad(m => { m.does.suggest = "memory.answer"; }), /does\.suggest names memory\.answer/);
  has(bad(m => { m.shows.notices.push("Late!"); }), /notices\[1\] must be lowercase letters/);
  has(bad(m => { m.teaches.tips[0].text = "x".repeat(141); }), /must be 1 to 140 characters/);
  has(bad(m => { m.teaches.tips[0].text = "Orders \u2014 today"; }), /no em dash/);
  has(bad(m => { m.teaches.tips[0].surfaces = ["watch"]; }), /surfaces\[0\] must be one of capsule/);
  has(bad(m => { m.teaches.tips[0].trigger = "always"; }), /trigger must be one of on-use/);
  has(bad(m => { m.teaches.tips[0].docs = "/etc/x.md"; }), /optional #anchor/);
  has(bad(m => { m.teaches.tips[0].since = "soon"; }), /must be a version like 0\.1\.0/);
  has(bad(m => { delete m.teaches.tips[0].level; }), /tips\[0\]\.level is required/);
  has(bad(m => { m.teaches.tips.push({ ...m.teaches.tips[0] }); }), /tip "orders-today" is declared twice/);
  has(bad(m => { m.roles = ["cloud"]; }), /roles\[0\] must be one of box, local, mac, windows/);
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
  assert.equal(SCHEMA.$id, "https://vyre.run/schema/module-1.json");
});

test("module sdk: flow.steps and flow.triggers compile to what Flows already have, and the checker refuses the wrong ones", () => {
  const base = () => ({ vyre: "1", name: "docs", version: "0.1.0", description: "Documents.",
    does: { tools: [{ name: "docs.find", reach: "anyone", effect: "read" }, { name: "docs.send", reach: "anyone", outward: "send" }, { name: "docs.secret", reach: "person" }] },
    watches: { emits: ["docs.signed"] },
    flow: { steps: [{ name: "docs.find", label: "Find a document", inputs: { q: "string" }, outputs: { n: "number" } }, { name: "docs.send", label: "Send a document", outward: true }],
      triggers: [{ name: "docs.signed-trigger", label: "A document is signed", event: "docs.signed", inputs: { id: "string" } }, { name: "docs.inbox", label: "A document lands", watcher: "docs.inbox" }] } });
  assert.deepEqual(checkManifest(base()), []);
  assert.deepEqual(flowSteps(base()).map(s => [s.name, s.risk]), [["docs.find", "read"], ["docs.send", "outward"]]);
  assert.deepEqual(flowTriggers(base()).map(t => t.trigger), [{ on: "event", event: "docs.signed" }, { on: "watcher", watcher: "docs.inbox" }]);
  const bad = (/** @type {(m: any) => void} */ f, /** @type {RegExp} */ re) => { const m = base(); f(m); assert.match(checkManifest(m).join("\n"), re); };
  bad(m => { m.flow.steps.push({ name: "docs.nope", label: "x" }); }, /is not one of this module's tools/);
  bad(m => { m.flow.steps[1].outward = false; }, /outward tool's step must say outward/);
  bad(m => { m.flow.steps[0].outward = true; }, /so its tool must be marked outward/);
  bad(m => { m.flow.steps.push({ name: "docs.secret", label: "x" }); }, /reach anyone/);
  bad(m => { m.flow.steps.push({ name: "docs.find", label: "again" }); }, /declared twice|uniqueItems|duplicate/);
  bad(m => { m.flow.triggers[0].event = "docs.other"; }, /not an event this module emits/);
  bad(m => { m.flow.triggers[1].event = "docs.signed"; }, /exactly one of event or watcher/);
  bad(m => { m.flow.triggers[0].name = "other.signed"; }, /must start with "docs\."/);
  assert.deepEqual(capabilities(base()).flows, { steps: [{ tool: "docs.find", label: "Find a document", outward: false }, { tool: "docs.send", label: "Send a document", outward: true }], triggers: [{ name: "docs.signed-trigger", label: "A document is signed" }, { name: "docs.inbox", label: "A document lands" }] });
  // an old per-tool declaration no longer does anything
  const old = base(); delete old.flow; old.does.tools[0].flowAction = { risk: "read" };
  assert.deepEqual(flowSteps(old), []);
});
