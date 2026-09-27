// @ts-check
// settings in a real vyred in a temp home: precedence, checking, each kind of store, and that
// only a person changes anything. Claude Code's files are a temp folder, never ~/.claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { coerce, validateDecls } from "../config/settings.js";

/** A vyred with one project (northwind) and Claude Code's folder in the temp home. */
async function world(t, { disable = [] } = {}) {
  const root = tempHome(t);
  const projects = path.join(root, "projects");
  const home = path.join(projects, "northwind");
  fs.mkdirSync(path.join(home, ".vyre"), { recursive: true });
  fs.writeFileSync(path.join(home, ".vyre", "project.json"), JSON.stringify({ name: "Northwind Bakery", slug: "northwind" }));
  const claudeDir = path.join(root, "claude");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn", ...disable] },
    projectsDir: projects, settings: { claude_dir: claudeDir } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}) => call(tool, input, { root });
  return { root, home, claudeDir, c, d };
}

test("every running module's declarations are valid, and a default passes its own check", async t => {
  const { c } = await world(t);
  const r = await c("settings.schema");
  assert.ok(r.data.keys.length > 40, "the core modules declare their settings");
  const seen = new Set();
  for (const k of r.data.keys) {
    assert.ok(!seen.has(k.key), `duplicate ${k.key}`); seen.add(k.key);
    assert.ok(k.key.startsWith(k.module + "."), k.key);
    if (k.default !== undefined) assert.deepEqual(coerce(k, k.default), k.default, k.key);
  }
});

test("a manifest's settings are checked: prefix, type, levels, a config store is account only", () => {
  assert.deepEqual(validateDecls("notes", [{ key: "notes.size", label: "Size", type: "int", levels: ["account"], apply: "live" }]), []);
  const bad = validateDecls("notes", [
    { key: "other.size", label: "x", type: "int", levels: ["account"], apply: "live" },
    { key: "notes.a", label: "x", type: "weird", levels: ["account"], apply: "live" },
    { key: "notes.b", label: "x", type: "int", levels: ["project"], apply: "live", store: { config: "notes.b" } },
  ]);
  assert.equal(bad.length, 3, bad.join("; "));
});

test("an enum's labels name only its own values", () => {
  const base = { key: "bakery.oven", label: "Oven", type: "enum", enum: ["gas", "wood"], levels: ["account"], apply: "live" };
  assert.deepEqual(validateDecls("bakery", [{ ...base, labels: { gas: "Gas oven" } }]), []);
  for (const labels of [{ coal: "Coal" }, { gas: "" }, ["Gas"], "Gas"]) {
    assert.match(validateDecls("bakery", [{ ...base, labels }]).join(), /labels/, JSON.stringify(labels));
  }
  assert.match(validateDecls("bakery", [{ ...base, type: "string", labels: { gas: "Gas" } }]).join(), /labels/);
});

test("coerce reads CLI text and refuses what is out of range", () => {
  const idle = { key: "sessions.idle_minutes", type: "int", min: 1, max: 1440 };
  assert.equal(coerce(idle, "15"), 15);
  assert.throws(() => coerce(idle, "0"), /at least 1/);
  assert.throws(() => coerce(idle, "1.5"), /whole number/);
  assert.equal(coerce({ key: "x", type: "bool" }, "on"), true);
  assert.deepEqual(coerce({ key: "x", type: "list" }, "Edit, Bash(npm test:*)"), ["Edit", "Bash(npm test:*)"]);
  assert.throws(() => coerce({ key: "x", type: "enum", enum: ["a"] }, "yolo"), /one of/);
  assert.throws(() => coerce({ key: "x", type: "int", choices: [0, 2, 5, 15] }, 3), /one of 0, 2, 5, 15/);
});

test("a project's value beats the account's, which beats the default; reset falls back a level", async t => {
  const { c } = await world(t);
  let r = await c("settings.get", { key: "sessions.send_while_busy", project: "northwind" });
  assert.deepEqual([r.data.value, r.data.source], ["steer", "default"]);

  r = await c("settings.set", { key: "sessions.send_while_busy", value: "queue" });
  assert.deepEqual([r.data.value, r.data.source], ["queue", "account"]);

  r = await c("settings.set", { key: "sessions.send_while_busy", value: "interrupt", project: "northwind" });
  assert.deepEqual([r.data.value, r.data.source, r.data.account], ["interrupt", "project", "queue"]);

  // Another project, or none, still sees the account's.
  assert.equal((await c("settings.get", { key: "sessions.send_while_busy" })).data.value, "queue");

  r = await c("settings.reset", { key: "sessions.send_while_busy", project: "northwind" });
  assert.deepEqual([r.data.value, r.data.source], ["queue", "account"]);
  r = await c("settings.reset", { key: "sessions.send_while_busy", level: "account" });
  assert.deepEqual([r.data.value, r.data.source], ["steer", "default"]);
});

test("an account-only key refuses a project value, and a bad value changes nothing", async t => {
  const { c } = await world(t);
  let r = await c("settings.set", { key: "sessions.idle_minutes", value: 30, project: "northwind", level: "project" });
  assert.equal(r.error.code, "bad_input");
  r = await c("settings.set", { key: "sessions.mode", value: "yolo" });
  assert.equal(r.error.code, "bad_input");
  assert.equal((await c("settings.get", { key: "sessions.mode" })).data.source, "default");
  assert.equal((await c("settings.set", { key: "no.such", value: 1 })).error.code, "not_found");
});

test("config.json keys are written in place and the running vyred sees them", async t => {
  const { c, root } = await world(t);
  await c("settings.set", { key: "sessions.idle_minutes", value: "25" });
  await c("settings.set", { key: "term.keep_hours", value: 4 });
  const file = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.equal(file.sessions.idle_minutes, 25);
  assert.equal(file.term.keep_hours, 4);
  assert.ok(file.projectsDir, "the rest of the file is kept");
  // The hand-back reads config live: its own tool sees the change at once.
  await c("settings.set", { key: "computers.handback_minutes", value: 15 });
  assert.equal((await c("computers.handback.status")).data.minutes, 15);
  await c("settings.reset", { key: "sessions.idle_minutes" });
  const after = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.equal(after.sessions, undefined, "an emptied section goes");
  assert.equal(after.term.keep_hours, 4);
  // Three levels deep, next to a sibling the reset must keep.
  await c("settings.set", { key: "sessions.box_teammates", value: 4 });
  await c("settings.set", { key: "sessions.box_subagents", value: 5 });
  await c("settings.reset", { key: "sessions.box_teammates" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).sessions, { limits: { max_subagents: 5 } });
  assert.equal((await c("sessions.limits.get")).data.box.subagent, 5);
});

test("Claude Code's rules go to its own files: the account's settings.json, the project's settings.local.json", async t => {
  const { c, home, claudeDir } = await world(t);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ model: "opus", permissions: { deny: ["Read(./.env)"] } }));
  assert.ok(!(await c("settings.set", { key: "sessions.allow", value: ["Bash(npm test:*)"], confirm: true })).error);
  const pr = await c("settings.set", { key: "sessions.allow", value: "Edit", project: "northwind", confirm: true });
  assert.ok(!pr.error, JSON.stringify(pr.error));
  const account = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  assert.deepEqual(account, { model: "opus", permissions: { deny: ["Read(./.env)"], allow: ["Bash(npm test:*)"] } });
  const local = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.local.json"), "utf8"));
  assert.deepEqual(local, { permissions: { allow: ["Edit"] } });
  const r = await c("settings.get", { key: "sessions.deny", project: "northwind" });
  assert.deepEqual([r.data.value, r.data.source, r.data.owner], [["Read(./.env)"], "account", "C"]);
});

test("a broken Claude Code file is never written over", async t => {
  const { c, claudeDir } = await world(t);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), "{ not json");
  const r = await c("settings.set", { key: "sessions.allow", value: ["Edit"], confirm: true });
  assert.ok(r.error, "refused");
  assert.equal(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"), "{ not json");
});

test("another module's keys go through its own tool, and a missing module reads as unavailable", async t => {
  const { c } = await world(t);
  await c("settings.set", { key: "push.watch", value: false });
  assert.equal((await c("push.settings")).data.kinds.watch, false);
  assert.ok(!(await c("settings.set", { key: "planner.event_lead", value: 20 })).error);
  assert.equal((await c("settings.get", { key: "planner.event_lead" })).data.value, 20);
  // The model per purpose lives in the sessions module, set through its own person-only tool.
  assert.ok(!(await c("settings.set", { key: "sessions.model.chat", value: "sonnet" })).error);
  assert.equal((await c("sessions.models.get")).data.purposes.chat.model, "sonnet");
  assert.ok(!(await c("settings.set", { key: "sessions.model", value: "haiku", project: "northwind" })).error);
  assert.equal((await c("settings.get", { key: "sessions.model", project: "northwind" })).data.value, "haiku");
  assert.ok(!(await c("settings.set", { key: "sessions.max_active", value: 2, project: "northwind" })).error);
  assert.equal((await c("sessions.limits.get", { project: "northwind" })).data.project.teammate, 2);
});

test("settings.changed says which key and level, never the value; resolve is for modules only", async t => {
  const { c, d } = await world(t);
  await c("settings.set", { key: "sessions.effort", value: "high", project: "northwind" });
  const e = d.events.since(0, { type: "settings.changed" }).at(-1);
  assert.deepEqual(e.payload, { key: "sessions.effort", level: "project", project: "northwind", apply: "session" });
  assert.equal((await c("settings.resolve", { project: "northwind" })).error.code, "no_such_tool");
});

test("a module switched off takes its settings with it", async t => {
  const { c, root } = await world(t, { disable: ["planner"] });
  const keys = (await c("settings.schema")).data.keys.map(k => k.key);
  assert.ok(!keys.some(k => k.startsWith("planner.")), "no planner rows");
  assert.ok(keys.includes("push.watch"));
  assert.ok(root);
});

test("widening what Claude may do needs confirm; loosening security needs a proof; a preview writes nothing", async t => {
  const { c, claudeDir } = await world(t);
  let r = await c("settings.set", { key: "sessions.allow", value: ["Bash(*)"] });
  assert.equal(r.error.code, "confirm_required");
  r = await c("settings.set", { key: "sessions.mode", value: "bypassPermissions" });
  assert.equal(r.error.code, "confirm_required");
  assert.ok(!(await c("settings.set", { key: "sessions.mode", value: "plan" })).error, "a mode that asks more needs nothing");
  r = await c("settings.set", { key: "sessions.allow", value: ["Bash(*)"], preview: true });
  assert.deepEqual([r.data.before, r.data.after, typeof r.data.confirm], [undefined, ["Bash(*)"], "string"]);
  assert.ok(r.data.where.includes("settings.json"));
  assert.ok(!fs.existsSync(path.join(claudeDir, "settings.json")), "a preview writes nothing");
  r = await c("settings.set", { key: "vault.lock_idle", value: "8h" });
  assert.equal(r.error.code, "presence_required");
});

test("the first write to a Claude Code file keeps a backup of it", async t => {
  const { c, claudeDir } = await world(t);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ theme: "dark" }));
  await c("settings.set", { key: "sessions.deny", value: ["Read(./.env)"] });
  await c("settings.set", { key: "sessions.deny", value: ["Read(./secrets)"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json.vyre-backup"), "utf8")), { theme: "dark" });
});

test("the schema lists every key once, with its group", async t => {
  const { c } = await world(t);
  const r = await c("settings.schema");
  const groups = new Set(r.data.groups.map(g => g.id));
  for (const k of r.data.keys) assert.ok(groups.has(k.group), `${k.key} has a known group`);
});

test("a module from outside Vyre keeps its settings inside its own rows (ADR 0033)", () => {
  const decl = (/** @type {any} */ store) => [{ key: "bakery.x", label: "X", type: "string", levels: ["account"], apply: "live", store }];
  const own = { tools: ["bakery.get", "bakery.set"] };
  assert.deepEqual(validateDecls("bakery", decl({ config: "bakery.x" }), own), []);
  assert.deepEqual(validateDecls("bakery", decl({ tool: { get: { tool: "bakery.get" }, set: { tool: "bakery.set" } } }), own), []);
  assert.match(validateDecls("bakery", decl({ claude: "permissions.allow" }), own).join(), /only Vyre's own modules may keep a setting in Claude Code's files/);
  assert.match(validateDecls("bakery", decl({ config: "gate.approvers" }), own).join(), /must start with "bakery\."/);
  assert.match(validateDecls("bakery", decl({ tool: { get: { tool: "bakery.get" }, set: { tool: "threads.answer" } } }), own).join(), /store\.tool\.set must be one of bakery's own tools/);
  // Vyre's own modules keep every store.
  assert.deepEqual(validateDecls("bakery", decl({ claude: "permissions.allow" }), { firstParty: true }), []);
});

test("a home module's setting stores are checked at load, and its tool store never hears the person", async t => {
  const root = tempHome(t);
  const mod = (/** @type {string} */ name, /** @type {any} */ manifest, /** @type {string} */ code) => {
    const dir = path.join(root, "modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name, version: "0.1.0", roles: ["box", "local"], ...manifest }));
    fs.writeFileSync(path.join(dir, "index.js"), code);
  };
  // Reaches past its rows three ways: refused at load, so none of its keys exist.
  mod("bakery", { does: { tools: ["bakery.noop"] }, settings: [
    { key: "bakery.theme", label: "Theme", type: "list", levels: ["account"], apply: "live", store: { claude: "permissions.allow" } },
    { key: "bakery.breads", label: "Breads", type: "list", levels: ["account"], apply: "live", store: { config: "gate.approvers" } },
    { key: "bakery.dark", label: "Dark", type: "bool", levels: ["account"], apply: "live", store: { tool: { get: { tool: "bakery.noop" }, set: { tool: "threads.answer", input: { id: "x", allow: "$value" } } } } },
  ] }, `export default { async start(ctx) { ctx.tool("bakery.noop", { run: async () => ({}) }); return { async stop() {} }; } };`);
  // Keeps its value in its own tool, and claims to be first-party: the claim is ignored.
  mod("oven", { does: { tools: ["oven.get", "oven.set"] }, settings: [
    { key: "oven.heat", label: "Heat", type: "int", levels: ["account"], apply: "live", firstParty: true, store: { tool: { get: { tool: "oven.get", read: "heat" }, set: { tool: "oven.set", input: { heat: "$value" } } } } },
  ] }, `let heat = 180; export const seen = [];
export default { async start(ctx) {
  ctx.tool("oven.get", { run: async (_i, { caller }) => { seen.push(caller); return { heat, seen }; } });
  ctx.tool("oven.set", { input: { type: "object" }, run: async (i, { caller }) => { seen.push(caller); heat = i.heat; return { heat }; } });
  return { async stop() {} };
} };`);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}) => call(tool, input, { root });

  const bakery = d.registry.status().find(m => m.name === "bakery");
  assert.equal(bakery.state, "invalid");
  assert.match(bakery.error, /Claude Code's files/);
  assert.match(bakery.error, /must start with "bakery\."/);
  assert.match(bakery.error, /store\.tool\.set must be one of bakery's own tools/);
  const keys = (await c("settings.schema")).data.keys.map(k => k.key);
  assert.ok(!keys.some(k => k.startsWith("bakery.")), "an invalid module's settings never appear");
  assert.ok(keys.includes("oven.heat"));

  let r = await c("settings.set", { key: "oven.heat", value: 200 });
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.equal(r.data.value, 200);
  r = await c("oven.get");
  assert.ok(r.data.seen.length >= 2, JSON.stringify(r.data.seen));
  assert.deepEqual([...new Set(r.data.seen.slice(0, -1))], ["module:settings"], "the settings module, never the person, reached the home module's tools");
});

test("only a person changes a setting: agent labels, mcp, anonymous and an unsigned owner device are refused, and confirm is no proof", async t => {
  const { d } = await world(t);
  const as = (/** @type {string} */ caller, /** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, caller);
  for (const tool of ["settings.set", "settings.reset"]) {
    const input = tool === "settings.set" ? { key: "sessions.mode", value: "bypassPermissions", confirm: true } : { key: "sessions.mode" };
    for (const caller of ["mcp", "mcp:agent:kit", "cli agent:kit", "deck agent:kit", "unknown", "module:bakery", "tailnet:agent:kit"]) {
      const r = await as(caller, tool, input);
      assert.equal(r.error && r.error.code, "denied", `${tool} from ${caller}: ${JSON.stringify(r)}`);
    }
    // The owner's own device over the tailnet still needs the person's session.
    assert.equal((await as("tailnet:alex", tool, input)).error.code, "person_session_required", tool);
    assert.equal((await as("device:abcdefghijklmnop", tool, input)).error.code, "person_session_required", tool);
  }
  const mode = (await d.registry.call("settings.get", { key: "sessions.mode" }, "cli")).data;
  assert.notEqual(mode.value, "bypassPermissions", "no refused call changed the mode");
  // A person with confirm goes through.
  assert.ok(!(await as("cli", "settings.set", { key: "sessions.mode", value: "bypassPermissions", confirm: true })).error);
});

test("settings passes the person on only to the getters and setters first-party settings declare", async t => {
  const { d } = await world(t);
  const rec = d.registry.modules.get("settings");
  const ctx = d.registry.context(rec.manifest);
  // A tool no setting names is refused as the person, even one the person may call.
  for (const tool of ["threads.answer", "agents.create", "vault.reveal", "settings.set"]) {
    assert.throws(() => ctx.call(tool, {}, { as: "cli" }), /settings may not call .* as cli/, tool);
  }
  // A declared setter and getter still hear the person.
  const r = await ctx.call("push.settings", {}, { as: "deck" });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.ok(d.registry.settingTools().has("sessions.models.set"));
  assert.ok(!d.registry.settingTools().has("threads.answer"));
});

test("a secret setting's values reach only the person: agents and a device without a session see names, never values", async t => {
  const { d, claudeDir } = await world(t);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ env: { NORTHWIND_TOKEN: "nw-secret-123", LOG_LEVEL: "debug" } }));
  const get = (/** @type {string} */ caller, /** @type {any} */ opts = {}) => d.registry.call("settings.get", { key: "sessions.env" }, caller, opts);
  for (const caller of ["mcp", "mcp:agent:kit", "cli agent:kit", "tailnet:agent:kit", "tailnet:alex", "device:abcdefghijklmnop", "module:bakery"]) {
    const r = await get(caller);
    assert.equal(r.error, undefined, `${caller}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.data.value, { NORTHWIND_TOKEN: "•••• set", LOG_LEVEL: "•••• set" }, caller);
    assert.ok(!JSON.stringify(r).includes("nw-secret-123"), `${caller} saw the value`);
    assert.equal(r.data.secret, true);
  }
  // A whole group read masks it too.
  const all = await d.registry.call("settings.get", {}, "mcp:agent:kit");
  assert.ok(!JSON.stringify(all).includes("nw-secret-123"), "the list leaks nothing");
  // The person, on the box's own surfaces or on their device with a person session, sees values.
  assert.equal((await get("cli")).data.value.NORTHWIND_TOKEN, "nw-secret-123");
  assert.equal((await get("tailnet:alex", { person: { id: "p1" } })).data.value.NORTHWIND_TOKEN, "nw-secret-123");
  // A plain key is not masked for anyone.
  assert.equal((await d.registry.call("settings.get", { key: "sessions.mode" }, "mcp:agent:kit")).data.value, "default");
});

test("maskFor masks only secret keys, keeps an object's names, and leaves unset alone", async () => {
  const { maskFor, MASK } = await import("./index.js");
  assert.deepEqual(maskFor({ secret: true }, { A: "1" }), { A: MASK });
  assert.equal(maskFor({ secret: true }, "tok"), MASK);
  assert.equal(maskFor({ secret: true }, undefined), undefined);
  assert.equal(maskFor({}, "plain"), "plain");
  assert.deepEqual(validateDecls("bakery", [{ key: "bakery.k", label: "K", type: "string", levels: ["account"], apply: "live", secret: "yes" }]), ["setting bakery.k: secret is true or false"]);
});
