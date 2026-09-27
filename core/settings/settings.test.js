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
import { KEYS, coerce, BY_KEY } from "./registry.js";

/** A vyred with one project (northwind) and Claude Code's folder in the temp home. */
async function world(t) {
  const root = tempHome(t);
  const projects = path.join(root, "projects");
  const home = path.join(projects, "northwind");
  fs.mkdirSync(path.join(home, ".vyre"), { recursive: true });
  fs.writeFileSync(path.join(home, ".vyre", "project.json"), JSON.stringify({ name: "Northwind Bakery", slug: "northwind" }));
  const claudeDir = path.join(root, "claude");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] },
    projectsDir: projects, settings: { claude_dir: claudeDir } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}) => call(tool, input, { root });
  return { root, home, claudeDir, c, d };
}

test("every key is well formed: unique, a known group, levels, and a default that passes its own check", () => {
  const seen = new Set();
  for (const k of KEYS) {
    assert.ok(!seen.has(k.key), `duplicate ${k.key}`); seen.add(k.key);
    assert.ok(k.levels.length && k.levels.every(l => l === "account" || l === "project"), k.key);
    assert.ok(["live", "session", "restart"].includes(k.apply), k.key);
    if (k.default !== undefined) assert.deepEqual(coerce(k, k.default), k.default, k.key);
  }
});

test("coerce reads CLI text and refuses what is out of range", () => {
  const k = /** @type {any} */ (BY_KEY.get("sessions.idle_minutes"));
  assert.equal(coerce(k, "15"), 15);
  assert.throws(() => coerce(k, "0"), /at least 1/);
  assert.throws(() => coerce(k, "1.5"), /whole number/);
  assert.equal(coerce(/** @type {any} */ (BY_KEY.get("fast")), "on"), true);
  assert.deepEqual(coerce(/** @type {any} */ (BY_KEY.get("permissions.allow")), "Edit, Bash(npm test:*)"), ["Edit", "Bash(npm test:*)"]);
  assert.throws(() => coerce(/** @type {any} */ (BY_KEY.get("permissions.mode")), "yolo"), /one of/);
  assert.throws(() => coerce(/** @type {any} */ (BY_KEY.get("glass.handback_minutes")), 3), /one of 0, 2, 5, 15/);
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
  r = await c("settings.set", { key: "permissions.mode", value: "yolo" });
  assert.equal(r.error.code, "bad_input");
  assert.equal((await c("settings.get", { key: "permissions.mode" })).data.source, "default");
  assert.equal((await c("settings.set", { key: "no.such", value: 1 })).error.code, "not_found");
});

test("config.json keys are written in place and the running vyred sees them", async t => {
  const { c, root } = await world(t);
  await c("settings.set", { key: "sessions.idle_minutes", value: "25" });
  await c("settings.set", { key: "vault.lock_idle", value: "30m" });
  const file = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.equal(file.sessions.idle_minutes, 25);
  assert.equal(file.vault.lock.idle, "30m");
  assert.ok(file.projectsDir, "the rest of the file is kept");
  // The hand-back reads config live: its own tool sees the change at once.
  await c("settings.set", { key: "glass.handback_minutes", value: 15 });
  assert.equal((await c("computers.handback.status")).data.minutes, 15);
  await c("settings.reset", { key: "sessions.idle_minutes" });
  const after = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.equal(after.sessions, undefined, "an emptied section goes");
  assert.equal(after.vault.lock.idle, "30m");
});

test("Claude Code's rules go to its own files: the account's settings.json, the project's settings.local.json", async t => {
  const { c, home, claudeDir } = await world(t);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ model: "opus", permissions: { deny: ["Read(./.env)"] } }));
  assert.ok(!(await c("settings.set", { key: "permissions.allow", value: ["Bash(npm test:*)"] })).error);
  const pr = await c("settings.set", { key: "permissions.allow", value: "Edit", project: "northwind" });
  assert.ok(!pr.error, JSON.stringify(pr.error));
  const account = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  assert.deepEqual(account, { model: "opus", permissions: { deny: ["Read(./.env)"], allow: ["Bash(npm test:*)"] } });
  const local = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.local.json"), "utf8"));
  assert.deepEqual(local, { permissions: { allow: ["Edit"] } });
  const r = await c("settings.get", { key: "permissions.deny", project: "northwind" });
  assert.deepEqual([r.data.value, r.data.source, r.data.owner], [["Read(./.env)"], "account", "C"]);
});

test("a broken Claude Code file is never written over", async t => {
  const { c, claudeDir } = await world(t);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), "{ not json");
  const r = await c("settings.set", { key: "permissions.allow", value: ["Edit"] });
  assert.ok(r.error, "refused");
  assert.equal(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"), "{ not json");
});

test("another module's keys go through its own tool, and a missing module reads as unavailable", async t => {
  const { c } = await world(t);
  await c("settings.set", { key: "notifications.watch", value: false });
  assert.equal((await c("push.settings")).data.kinds.watch, false);
  assert.ok(!(await c("settings.set", { key: "planner.event_lead", value: 20 })).error);
  assert.equal((await c("settings.get", { key: "planner.event_lead" })).data.value, 20);
  // The model per purpose lives in the sessions module; without it, the key says so.
  const m = await c("settings.get", { key: "model.chat" });
  if (!(await c("sessions.models.get")).error) return;
  assert.equal(m.data.available, false);
  assert.equal(m.data.value, "opus");
});

test("settings.changed says which key and level, never the value; resolve is for modules only", async t => {
  const { c, d } = await world(t);
  await c("settings.set", { key: "effort", value: "high", project: "northwind" });
  const e = d.events.since(0, { type: "settings.changed" }).at(-1);
  assert.deepEqual(e.payload, { key: "effort", level: "project", project: "northwind", apply: "session" });
  assert.equal((await c("settings.resolve", { project: "northwind" })).error.code, "no_such_tool");
});

test("the schema lists every key once, with its group", async t => {
  const { c } = await world(t);
  const r = await c("settings.schema");
  assert.equal(r.data.keys.length, KEYS.length);
  const groups = new Set(r.data.groups.map(g => g.id));
  for (const k of r.data.keys) assert.ok(groups.has(k.group), `${k.key} has a known group`);
});
