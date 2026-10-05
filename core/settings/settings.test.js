// @ts-check
// settings in a real vyred in a temp home: precedence, checking, each kind of store, and that
// only a person changes anything. Claude Code's files are a temp folder, never ~/.claude.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, kernelCaller } from "../../test/helpers.js";
import { coerce, validateDecls } from "../config/settings.js";
import { MASK } from "./index.js";
import { settingTo, settingIntents } from "../../lib/said/setting.js";

/** A vyred with one project (northwind) and Claude Code's folder in the temp home. */
async function world(t, { disable = [], kernel = false } = {}) {
  const root = tempHome(t);
  // The planner keeps its records in the kernel: a world that sets one of its keys starts with the kernel on, this development tree counted as first party.
  if (kernel) { process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1"; t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; }); }
  const projects = path.join(root, "projects");
  const home = path.join(projects, "northwind");
  fs.mkdirSync(path.join(home, ".vyre"), { recursive: true });
  const claudeDir = path.join(root, "claude");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn", ...disable] },
    projectsDir: projects, settings: { claude_dir: claudeDir } }));
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")], ...(kernel ? { kernel: true } : {}) });
  t.after(() => d.stop());
  await d.registry.call("projects.create", { name: "Northwind", home }, "cli");
  await d.registry.call("projects.rename", { project: "northwind", name: "Northwind Bakery" }, "cli");
  const c = (/** @type {string} */ tool, input = {}) => call(tool, input, { root });
  return { root, home, claudeDir, c, d };
}

test("every running module's declarations are valid, and a default passes its own check", { timeout: 30_000 }, async t => {
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

test("ADR 0035 levels and hooks: device never with confirm or security, session only with a tool store, check and choicesFrom name own tools", () => {
  const base = { key: "bakery.oven", label: "Oven", type: "string", levels: ["account"], apply: "live" };
  const bad = (/** @type {any} */ d, /** @type {RegExp} */ re) => assert.match(validateDecls("bakery", [{ ...base, ...d }], { tools: ["bakery.check", "bakery.get", "bakery.set"] }).join(" | "), re, JSON.stringify(d));
  bad({ levels: ["device"], confirm: true }, /may not be set per device/);
  bad({ levels: ["device"], security: "loosens" }, /may not be set per device/);
  bad({ levels: ["session"] }, /session level needs a store in this module's own tools/);
  bad({ check: { tool: "vault.reveal" } }, /check\.tool must be one of bakery's own tools/);
  bad({ choicesFrom: { tool: "bakery.nope" } }, /choicesFrom\.tool must be one of bakery's own tools/);
  bad({ choices: { tool: "bakery.get" } }, /choices is a list of numbers; a tool goes in choicesFrom/);
  assert.deepEqual(validateDecls("bakery", [{ ...base, check: { tool: "bakery.check" }, choicesFrom: { tool: "bakery.get" } }], { tools: ["bakery.check", "bakery.get"] }), []);
});

test("the person's own changes ask nothing (C25): env, plugins and taking an entry off deny just apply; a preview still says what it widens", { timeout: 30_000 }, async t => {
  const { c, claudeDir } = await world(t);
  assert.ok(!(await c("settings.set", { key: "sessions.env", value: { LOG_LEVEL: "debug" } })).error);
  assert.ok(!(await c("settings.set", { key: "sessions.plugins", value: { "bakery@market": true } })).error);
  assert.ok(!(await c("settings.set", { key: "sessions.deny", value: ["Bash(rm:*)", "WebFetch"] })).error, "adding to deny is stricter");
  assert.equal((await c("settings.set", { key: "sessions.deny", value: ["Bash(rm:*)"], preview: true })).data.confirm, "Claude will no longer be refused what you take off this list.");
  const r = await c("settings.set", { key: "sessions.deny", value: ["Bash(rm:*)"] });
  assert.ok(!r.error, "dropping WebFetch applies at once; the log and Undo are the safety");
  assert.equal((await c("settings.changes", { key: "sessions.deny" })).data[0].by, "cli");
  assert.ok(!(await c("settings.reset", { key: "sessions.deny" })).error, "a reset drops them all, no confirm");
  assert.equal(JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8")).permissions?.deny, undefined);
  assert.ok(!(await c("settings.reset", { key: "sessions.ask" })).error, "nothing to drop, nothing to ask");
});

test("asPerson names a person's surface, the owner's device as the Deck, and refuses anything else", async () => {
  const { asPerson } = await import("./index.js");
  assert.equal(asPerson("cli"), "cli");
  assert.equal(asPerson("tailnet:alex"), "deck");
  assert.equal(asPerson("device:abcdefghijklmnop"), "deck");
  for (const c of ["mcp", "tailnet:agent:kit", "cli agent:kit", "module:bakery", "tailnet-guest:juno", "unknown"]) assert.throws(() => asPerson(c), /not a person's surface/, c);
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

test("a project's value beats the account's, which beats the default; reset falls back a level", { timeout: 30_000 }, async t => {
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

test("an account-only key refuses a project value, and a bad value changes nothing", { timeout: 30_000 }, async t => {
  const { c } = await world(t);
  let r = await c("settings.set", { key: "sessions.idle_minutes", value: 30, project: "northwind", level: "project" });
  assert.equal(r.error.code, "bad_input");
  r = await c("settings.set", { key: "sessions.mode", value: "yolo" });
  assert.equal(r.error.code, "bad_input");
  assert.equal((await c("settings.get", { key: "sessions.mode" })).data.source, "default");
  assert.equal((await c("settings.set", { key: "no.such", value: 1 })).error.code, "not_found");
});

test("config.json keys are written in place and the running vyred sees them", { timeout: 30_000 }, async t => {
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

test("Claude Code's rules go to its own files: the account's settings.json, the project's settings.local.json", { timeout: 30_000 }, async t => {
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

test("a broken Claude Code file is never written over", { timeout: 30_000 }, async t => {
  const { c, claudeDir } = await world(t);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), "{ not json");
  const r = await c("settings.set", { key: "sessions.allow", value: ["Edit"], confirm: true });
  assert.ok(r.error, "refused");
  assert.equal(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"), "{ not json");
});

test("another module's keys go through its own tool, and a missing module reads as unavailable", { timeout: 30_000 }, async t => {
  const { c } = await world(t, { kernel: true });
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

test("settings.changed says which key, level and rev, the new value only for a key that isn't secret; resolve is for modules only", { timeout: 30_000 }, async t => {
  const { c, d } = await world(t);
  await c("settings.set", { key: "sessions.effort", value: "high", project: "northwind" });
  const e = d.events.since(0, { type: "settings.changed" }).at(-1);
  assert.equal(typeof e.payload.rev, "number");
  assert.match(e.payload.change, /^chg_/, "every change carries the id settings.undo takes");
  assert.deepEqual({ ...e.payload, rev: 0, change: "chg" }, { key: "sessions.effort", level: "project", project: "northwind", apply: "session", rev: 0, change: "chg", by: "person", value: "high" });
  await c("settings.reset", { key: "sessions.effort", project: "northwind" });
  assert.equal(d.events.since(0, { type: "settings.changed" }).at(-1).payload.value, null, "a reset says null");
  // A secret key's change never carries its value.
  await c("settings.set", { key: "sessions.env", value: { NORTHWIND_TOKEN: "nw-secret-123" }, confirm: true });
  const s = d.events.since(0, { type: "settings.changed" }).at(-1).payload;
  assert.equal(s.key, "sessions.env");
  assert.ok(!("value" in s) && !JSON.stringify(s).includes("nw-secret"));
  assert.equal((await c("settings.resolve", { project: "northwind" })).error.code, "no_such_tool");
});

test("a module switched off takes its settings with it", { timeout: 30_000 }, async t => {
  const { c, root } = await world(t, { disable: ["planner"] });
  const keys = (await c("settings.schema")).data.keys.map(k => k.key);
  assert.ok(!keys.some(k => k.startsWith("planner.")), "no planner rows");
  assert.ok(keys.includes("push.watch"));
  assert.ok(root);
});

test("widening what Claude may do and loosening security need no confirm and no proof from the person (C25); a preview writes nothing; Undo puts it back", { timeout: 30_000 }, async t => {
  const { c, claudeDir } = await world(t);
  let r = await c("settings.set", { key: "sessions.allow", value: ["Bash(*)"], preview: true });
  assert.deepEqual([r.data.before, r.data.after, typeof r.data.confirm], [undefined, ["Bash(*)"], "string"], "a preview still names what it widens");
  assert.ok(r.data.where.includes("settings.json"));
  assert.ok(!fs.existsSync(path.join(claudeDir, "settings.json")), "a preview writes nothing");
  assert.ok(!(await c("settings.set", { key: "sessions.allow", value: ["Bash(*)"] })).error);
  assert.ok(!(await c("settings.set", { key: "sessions.mode", value: "plan" })).error);
  r = await c("settings.set", { key: "vault.lock_idle", value: "8h" });
  assert.ok(!r.error, "a security setting: no Touch ID, no confirm");
  const log = (await c("settings.changes", { key: "vault.lock_idle" })).data;
  assert.equal(log.length, 1);
  assert.ok(!(await c("settings.undo", { change: log[0].id })).error, "and Undo, with no prompt either");
  assert.notEqual((await c("settings.get", { key: "vault.lock_idle" })).data.value, "8h");
});

test("the first write to a Claude Code file keeps a backup of it", { timeout: 30_000 }, async t => {
  const { c, claudeDir } = await world(t);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ theme: "dark" }));
  await c("settings.set", { key: "sessions.deny", value: ["Read(./.env)"] });
  await c("settings.set", { key: "sessions.deny", value: ["Read(./secrets)"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json.vyre-backup"), "utf8")), { theme: "dark" });
});

test("the schema lists every key once, with its group", { timeout: 30_000 }, async t => {
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
  // A home module is third party here (the kernel runs it in its sandbox); the second start below trusts the home's folder so the oven, written for the in-process API, can run.
  let d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}) => call(tool, input, { root });

  const bakery = d.registry.status().find(m => m.name === "bakery");
  assert.equal(bakery.state, "invalid");
  assert.match(bakery.error, /Claude Code's files/);
  assert.match(bakery.error, /must start with "bakery\."/);
  assert.match(bakery.error, /store\.tool\.set must be one of bakery's own tools/);
  const keys = (await c("settings.schema")).data.keys.map(k => k.key);
  assert.ok(!keys.some(k => k.startsWith("bakery.")), "an invalid module's settings never appear");
  await d.stop();
  d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  assert.ok((await c("settings.schema")).data.keys.some((/** @type {any} */ k) => k.key === "oven.heat"));

  let r = await c("settings.set", { key: "oven.heat", value: 200 });
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.equal(r.data.value, 200);
  r = await c("oven.get");
  assert.ok(r.data.seen.length >= 2, JSON.stringify(r.data.seen));
  // The oven is trusted by path in this second start, so it is first party and its declared setter hears the person ("local": the settings module passes the person on to a first-party setter, as the next test pins).
  // A home module that is not trusted runs in the sandbox, never reaches this path, and never appears in settingTools (checked below).
  assert.deepEqual([...new Set(r.data.seen)].sort(), ["cli", "local"], "a first-party setter hears the person's own surfaces, and nothing else");
  await d.stop();
  d = await start({ root, log: () => {} });
  assert.ok(!d.registry.settingTools().has("oven.set"), "an untrusted home module's tool is no setting tool, so settings never passes the person to it");
});

test("only a person changes a setting: agent labels, mcp, anonymous and an unsigned owner device are refused, and confirm is no proof", { timeout: 30_000 }, async t => {
  const { d, c } = await world(t);
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
  // The person's own surface is the socket (with the kernel on a registry call labelled "cli" has no person chain).
  assert.ok(!(await c("settings.set", { key: "sessions.mode", value: "bypassPermissions", confirm: true })).error);
});

test("settings passes the person on only to the getters and setters first-party settings declare", { timeout: 30_000 }, async t => {
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

test("a secret setting's values reach only the person: agents and a device without a session see names, never values", { timeout: 30_000 }, async t => {
  const { d, c, claudeDir } = await world(t);
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
  assert.equal((await c("settings.get", { key: "sessions.env" })).data.value.NORTHWIND_TOKEN, "nw-secret-123");
  // A device's person session is a kernel chain: a registry call carries no chain, so the paired-device read is covered by the kernel's own tests.
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

/** A home module that writes settings through settings.write, via a tool the test can call. */
function homeModule(root, name, settings) {
  const dir = path.join(root, "modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name, version: "0.1.0", roles: ["box", "local"], does: { tools: [`${name}.put`] }, settings }));
  fs.writeFileSync(path.join(dir, "index.js"), `export default { async start(ctx) {
    ctx.tool("${name}.put", { input: { type: "object" }, run: async i => {
      const r = await ctx.call("settings.write", i);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.data;
    } });
    return { async stop() {} };
  } };`);
}

test("settings.write: a module sets its own plain keys, and nothing else", async t => {
  const root = tempHome(t);
  homeModule(root, "bakery", [
    { key: "bakery.opens", label: "Opening hour", type: "int", min: 0, max: 23, default: 7, levels: ["account", "project"], apply: "live" },
    { key: "bakery.fax", label: "Fax orders", type: "bool", levels: ["account"], apply: "live", confirm: true },
    { key: "bakery.wide", label: "Wide", type: "bool", levels: ["account"], apply: "live", security: "loosens", loosens: "everything" },
    { key: "bakery.cfg", label: "In config", type: "int", levels: ["account"], apply: "live", store: { config: "bakery.cfg" } },
  ]);
  homeModule(root, "oven", [{ key: "oven.heat", label: "Heat", type: "int", levels: ["account"], apply: "live" }]);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  // The fixture stands in for one of Vyre's own modules calling settings.write (ADR 0047: an added
  // module sets its settings through ctx.settings.set instead), so it loads as first party.
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}) => call(tool, input, { root });
  /** @type {any[]} */
  const seen = [];
  d.events.on("settings.changed", e => seen.push(e.payload));

  // Its own plain key: written, then the person sees it.
  let r = await c("bakery.put", { key: "bakery.opens", value: 9 });
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.deepEqual([r.data.value, r.data.source], [9, "account"]);
  r = await c("settings.get", { key: "bakery.opens" });
  assert.deepEqual([r.data.value, r.data.source], [9, "account"]);
  assert.deepEqual(seen.map(e => [e.key, e.by]), [["bakery.opens", "module:bakery"]], "the change says which module made it");
  assert.equal(seen[0].value, 9, "a plain key's event carries its new value");
  assert.ok(Number.isInteger(seen[0].rev) && seen[0].rev > 0, "and the hub's new rev");
  r = await c("bakery.put", { key: "bakery.opens", value: 99 });
  assert.match(r.error.message, /at most 23/);

  // Someone else's key, a confirm key, a loosening key, a key kept outside Vyre's table.
  for (const [key, why] of [["oven.heat", /only its own settings/], ["bakery.fax", /needs the person's confirm/], ["bakery.wide", /needs the person's confirm/], ["bakery.cfg", /kept outside/]]) {
    r = await c("bakery.put", { key, value: key === "oven.heat" ? 1 : true });
    assert.ok(r.error, key);
    assert.match(r.error.message, why, key);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).bakery, undefined, "config.json untouched");

  // A reset clears the module's own value.
  r = await c("bakery.put", { key: "bakery.opens" });
  assert.deepEqual([r.data.value, r.data.source], [7, "default"]);

  // Not a surface's tool: the CLI, a person, can't even see it.
  r = await c("settings.write", { key: "bakery.opens", value: 8 });
  assert.equal(r.error.code, "no_such_tool");
});

test("settings.write: a module's own secret key comes back masked, like settings.get for anyone but the person", async t => {
  const root = tempHome(t);
  homeModule(root, "bakery", [{ key: "bakery.token", label: "Till token", type: "string", levels: ["account"], apply: "live", secret: true }]);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  // The fixture stands in for one of Vyre's own modules calling settings.write (ADR 0047: an added
  // module sets its settings through ctx.settings.set instead), so it loads as first party.
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const r = await call("bakery.put", { key: "bakery.token", value: "northwind-till-1" }, { root });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.data.value, MASK);
  const e = d.events.since(0, { type: "settings.changed" }).at(-1).payload;
  assert.equal(e.key, "bakery.token");
  assert.ok(!("value" in e), "a secret key's event never carries its value");
  assert.ok(Number.isInteger(e.rev));
  // hub.json is plain text and goes into the backup: the secret never reaches it.
  let hub = "";
  try { hub = fs.readFileSync(path.join(root, "hub.json"), "utf8"); } catch {}
  assert.ok(!hub.includes("northwind-till-1"), "the secret's value is not in hub.json");
  assert.ok(!hub.includes("bakery.token"), "nor is its key");
  // The person still gets it back in the clear.
  const own = await call("settings.get", { key: "bakery.token" }, { root });
  assert.equal(own.error, undefined, JSON.stringify(own.error));
  assert.equal(own.data.value, "northwind-till-1");
});

test("an agent changes a setting only when the person asked (C25, P17), every change is logged, and undo needs no prompt", { timeout: 30_000 }, async t => {
  const { c, d } = await world(t);
  const schema = (await c("settings.schema")).data.keys;
  const k = schema.find((/** @type {any} */ x) => x.type === "bool" && !x.store && !x.secret && !x.confirm && x.security !== "loosens" && x.levels.includes("account"));
  assert.ok(k, "a plain on/off setting to try");
  const want = !(k.default === true);
  const agent = "mcp:agent:kit", meta = { thread: "t_asked" };
  const req = (/** @type {any} */ input, /** @type {any} */ m = meta) => d.registry.call("settings.request", input, agent, m);

  // Nothing the person said yet: refused, in words the agent can pass on.
  let r = await req({ key: k.key, value: want });
  assert.equal(r.error?.code, "denied");
  assert.match(r.error.message, /changes only when the person asks for it/);

  // The real vault keeps what the person said; sessions record it from a `said` row.
  const say = (/** @type {any} */ i) => d.registry.call("vault.said.record", { said: "row-1", what: "use this setting", ...i }, "module:sessions");
  const to = (/** @type {any} */ v, level = "account") => settingTo({ key: k.key, value: v, level });
  assert.ok(!(await say({ thread: "t_other", kind: "setting", to: [to(want)] })).error, "recorded for another thread");
  r = await req({ key: k.key, value: want });
  assert.equal(r.error?.code, "denied", "words in another thread don't count");
  assert.ok(!(await say({ thread: "t_asked", kind: "setting", to: [k.key] })).error);
  r = await req({ key: k.key, value: want });
  assert.equal(r.error?.code, "denied", "an ask that names only the key covers no value");
  assert.ok(!(await say({ thread: "t_asked", kind: "setting", to: [to(!want)] })).error);
  r = await req({ key: k.key, value: want });
  assert.equal(r.error?.code, "denied", "an ask for the opposite value doesn't count");
  assert.ok(!(await say({ thread: "t_asked", kind: "setting", to: [settingTo({ key: "some.other.key", value: want, level: "account" })] })).error);
  r = await req({ key: k.key, value: want });
  assert.equal(r.error?.code, "denied", "an ask that names a different key doesn't count");
  assert.ok(!(await say({ thread: "t_asked", kind: "send", to: [to(want)] })).error);
  r = await req({ key: k.key, value: want });
  assert.equal(r.error?.code, "denied", "an ask of another kind doesn't count");
  assert.equal((await c("settings.get", { key: k.key })).data.value, k.default, "none of those changed it");

  const asked = await say({ thread: "t_asked", kind: "setting", to: [to(want)] });
  assert.ok(!asked.error, JSON.stringify(asked.error));
  r = await req({ key: k.key, value: want });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal((await c("settings.get", { key: k.key })).data.value, want);
  assert.equal((await req({ key: k.key, value: want })).error?.code, "denied", "one ask, one change: it was used up");
  assert.equal((await req({ key: k.key, value: want }, {})).error?.code, "denied", "outside a conversation: refused");

  // The direct path stays the person's.
  assert.equal((await d.registry.call("settings.set", { key: k.key, value: !want }, agent, meta)).error?.code, "denied");

  const log = (await c("settings.changes", { key: k.key })).data;
  assert.equal(log[0].by, agent);
  assert.equal(log[0].said, asked.data.id, "the change carries the intent that covered it");
  assert.equal(log[0].undone, false);

  const u = await c("settings.undo", { change: log[0].id });
  assert.ok(!u.error, JSON.stringify(u.error));
  assert.equal((await c("settings.get", { key: k.key })).data.value, k.default ?? false, "the value before comes back");
  assert.equal((await c("settings.changes", { key: k.key })).data.find((/** @type {any} */ x) => x.id === log[0].id).undone, true);
  assert.equal((await c("settings.undo", { change: log[0].id })).error?.code, "bad_input", "once");
  assert.equal((await d.registry.call("settings.undo", { change: log[0].id }, agent, meta)).error?.code, "denied", "undo is the person's");
});

test("the recorder's string for a setting ask is the one settings.request asks for, value and level included (reviewer-2's alignment check)", { timeout: 30_000 }, async t => {
  const { c, d, root } = await world(t);
  const keys = (await c("settings.schema")).data.keys;
  // A plain on/off setting that is set per project, worded the way a person would say it.
  let found = null;
  for (const x of keys) {
    if (x.type !== "bool" || !x.levels.includes("project") || !x.label || x.secret || x.confirm || x.security === "loosens") continue;
    const r = settingIntents(`Turn on ${String(x.label).toLowerCase()} in this project.`, keys, { project: "northwind" });
    if (r.intents.length === 1 && r.intents[0].to[0].startsWith(`${x.key}=`)) { found = { x, intents: r.intents }; break; }
  }
  assert.ok(found, "a bool project setting the recorder can name");
  const { x: m, intents } = found;
  assert.ok(!(await kernelCaller(d, root)("agents.create", { name: "kit", projects: ["northwind"] })).error);
  const say = (/** @type {any} */ i) => d.registry.call("vault.said.record", { said: "row-1", what: "a setting ask", ...i }, "module:sessions");
  const agent = "mcp:agent:kit";
  const req = (/** @type {any} */ input) => d.registry.call("settings.request", input, agent, { thread: "t_rec" });
  assert.ok(!(await say({ thread: "t_rec", kind: intents[0].kind, to: intents[0].to })).error);
  // The recorder's ask was for `true` at the project level. Wrong value, wrong level: refused, the intent untouched.
  assert.equal((await req({ key: m.key, value: false, level: "project", project: "northwind" })).error?.code, "denied", "the opposite value");
  assert.equal((await req({ key: m.key, value: true, level: "account" })).error?.code, "denied", "another level");
  // The exact ask: allowed once.
  const ok = await req({ key: m.key, value: true, level: "project", project: "northwind" });
  assert.ok(!ok.error, JSON.stringify(ok.error));
  assert.equal((await req({ key: m.key, value: true, level: "project", project: "northwind" })).error?.code, "denied", "used up");
});

test("an agent's asked change that loosens a guard posts settings.loosened with the change and the turn that asked; nothing else does", async t => {
  const { c, d } = await world(t);
  const keys = (await c("settings.schema")).data.keys;
  const loose = keys.find((/** @type {any} */ x) => x.key === "vault.lock_on_sleep");
  const plain = keys.find((/** @type {any} */ x) => x.type === "bool" && x.levels.includes("account") && !x.secret && !x.confirm && x.security !== "loosens" && x.key !== "vault.lock_on_sleep");
  assert.ok(loose && plain, "a loosening key and a plain one");
  const say = (/** @type {any} */ i) => d.registry.call("vault.said.record", { said: "row-7", what: "a setting ask", ...i }, "module:sessions");
  const agent = "mcp:agent:kit", meta = { thread: "t_loose" };
  const req = (/** @type {any} */ input) => d.registry.call("settings.request", input, agent, meta);
  const seen = () => d.events.since(0, { type: "settings.loosened" });
  // The person says "turn it off": the key goes to false (the loosening direction for a lock).
  const asked = await say({ thread: "t_loose", kind: "setting", to: [settingTo({ key: loose.key, value: false, level: "account" })] });
  assert.ok(!asked.error, JSON.stringify(asked.error));
  const r = await req({ key: loose.key, value: false });
  assert.ok(!r.error, JSON.stringify(r.error));
  const ev = seen();
  assert.equal(ev.length, 1);
  const log = (await c("settings.changes", { key: loose.key })).data;
  assert.deepEqual([ev[0].payload.key, ev[0].payload.level, ev[0].payload.by, ev[0].payload.said, ev[0].payload.change, ev[0].payload.label], [loose.key, "account", agent, asked.data.id, log[0].id, loose.label]);
  assert.ok(!("value" in ev[0].payload) && !JSON.stringify(ev[0].payload).includes("false"), "the event never carries a value");
  // The Undo needs no proof, and a plain asked change posts no notice.
  assert.ok(!(await c("settings.undo", { change: log[0].id })).error);
  const plainAsk = await say({ thread: "t_loose", kind: "setting", to: [settingTo({ key: plain.key, value: !(plain.default === true), level: "account" })] });
  assert.ok(!plainAsk.error);
  assert.ok(!(await req({ key: plain.key, value: !(plain.default === true) })).error);
  assert.equal(seen().length, 1, "a plain asked change is not a notice");
  // The person's own change of the same key is not a notice either.
  assert.ok(!(await c("settings.set", { key: loose.key, value: false })).error);
  assert.equal(seen().length, 1, "the person's own change is not a notice");
});
