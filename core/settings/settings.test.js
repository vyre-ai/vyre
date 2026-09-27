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
