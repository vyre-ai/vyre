// @ts-check
// The hub file (ADR 0035) in a real vyred in a temp home: it mirrors every change with a rev, a
// person's hand edit applies, a bad one is named and kept out, one that widens what Claude may do
// waits for the person, a broken file is kept aside, and a session can't touch it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { rules } from "../harness/rules.js";
import { backup } from "../names/backup.js";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

async function world(t, { before } = /** @type {{ before?: (root: string) => void }} */ ({})) {
  const root = tempHome(t);
  const projects = path.join(root, "projects");
  const home = path.join(projects, "northwind");
  fs.mkdirSync(path.join(home, ".vyre"), { recursive: true });
  fs.writeFileSync(path.join(home, ".vyre", "project.json"), JSON.stringify({ name: "Northwind Bakery", slug: "northwind" }));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, projectsDir: projects, settings: { claude_dir: path.join(root, "claude") } }));
  before?.(root);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}) => call(tool, input, { root });
  const file = path.join(root, "hub.json");
  const hub = () => JSON.parse(fs.readFileSync(file, "utf8"));
  /** Edit the file as a person would, then give the watcher a moment. */
  const edit = async (/** @type {(h: any) => void} */ f) => { const h = hub(); f(h); fs.writeFileSync(file, JSON.stringify(h, null, 2)); await sleep(400); };
  return { root, d, c, file, hub, edit };
}

test("hub.json is made at first start and mirrors every change, each with the next rev", async t => {
  const { d, c, hub } = await world(t);
  const r0 = hub().rev;
  assert.deepEqual(hub().account, {});
  await c("settings.set", { key: "sessions.effort", value: "high" });
  await c("settings.set", { key: "sessions.max_turns", value: 40, project: "northwind" });
  assert.equal(hub().account["sessions.effort"], "high");
  assert.equal(hub().projects.northwind["sessions.max_turns"], 40);
  assert.equal(hub().rev, r0 + 2);
  const ev = d.events.since(0, { type: "settings.changed" });
  assert.deepEqual(ev.map(e => e.payload.rev), [r0 + 1, r0 + 2]);
  // A key kept elsewhere (a module's tool) still moves rev, and never lands in the file.
  await c("settings.set", { key: "push.watch", value: false });
  assert.equal(hub().rev, r0 + 3);
  assert.ok(!("push.watch" in hub().account));
  await c("settings.reset", { key: "sessions.effort" });
  assert.ok(!("sessions.effort" in hub().account));
  assert.equal((await c("settings.schema")).data.hub.rev, r0 + 4);
});

test("a person's edit to hub.json applies live and says so; a bad value is kept out and named on its row", async t => {
  const { d, c, hub, edit } = await world(t);
  await edit(h => { h.account["sessions.effort"] = "max"; });
  const e = d.events.since(0, { type: "settings.changed" }).at(-1);
  assert.equal(e?.payload.key, "sessions.effort");
  assert.equal(e.payload.by, "hub.json");
  assert.equal((await c("settings.get", { key: "sessions.effort" })).data.value, "max");
  const before = fs.readFileSync(path.join(d.paths.root, "hub.json"), "utf8");
  await edit(h => { h.account["sessions.max_turns"] = 0; h.account["bakery.oven"] = true; });
  const row = (await c("settings.get", { key: "sessions.max_turns" })).data;
  assert.equal(row.value, undefined, "the bad value is not in effect");
  assert.match(row.problem, /hub\.json: sessions\.max_turns/);
  assert.equal(hub().account["sessions.max_turns"], 0, "the person's text stays in the file");
  assert.notEqual(before, fs.readFileSync(path.join(d.paths.root, "hub.json"), "utf8"));
});

test("a hand edit that widens what Claude may do waits for the person, then applies with their confirm", async t => {
  const { d, c, edit, hub } = await world(t);
  const n = d.events.since(0, { type: "settings.changed" }).length;
  await edit(h => { h.account["sessions.mode"] = "bypassPermissions"; });
  let row = (await c("settings.get", { key: "sessions.mode" })).data;
  assert.equal(row.value, "default", "not applied");
  assert.deepEqual(row.pending, { level: "account", value: "bypassPermissions", from: "hub.json" });
  assert.equal(d.events.since(0, { type: "settings.changed" }).length, n, "nothing changed");
  assert.equal((await d.registry.call("settings.get", { key: "sessions.mode" }, "mcp:agent:kit")).data.value, "default");
  // The person accepts it in the Deck: the same set, with confirm.
  assert.ok(!(await c("settings.set", { key: "sessions.mode", value: "bypassPermissions", confirm: true })).error);
  row = (await c("settings.get", { key: "sessions.mode" })).data;
  assert.equal(row.value, "bypassPermissions");
  assert.equal(row.pending, undefined);
  assert.equal(hub().account["sessions.mode"], "bypassPermissions");
});

test("edits made while vyred was off are read at start, and a held one still waits", async t => {
  const { c } = await world(t, { before: root => fs.writeFileSync(path.join(root, "hub.json"), JSON.stringify({ rev: 3,
    account: { "sessions.fast": true, "sessions.mode": "dontAsk" }, projects: { northwind: { "sessions.effort": "low" } } })) });
  assert.equal((await c("settings.get", { key: "sessions.fast" })).data.value, true);
  assert.equal((await c("settings.get", { key: "sessions.effort", project: "northwind" })).data.value, "low");
  const mode = (await c("settings.get", { key: "sessions.mode" })).data;
  assert.equal(mode.value, "default");
  assert.equal(mode.pending.value, "dontAsk");
});

test("a broken hub.json is named, kept aside on the next change, and rebuilt from what is in effect", async t => {
  const { root, c, hub } = await world(t);
  await c("settings.set", { key: "sessions.effort", value: "high" });
  fs.writeFileSync(path.join(root, "hub.json"), "{ \"account\": { \"sessions.effort\": ");
  await sleep(400);
  assert.match((await c("settings.schema")).data.hub.problem, /not valid JSON/);
  assert.equal((await c("settings.get", { key: "sessions.effort" })).data.value, "high", "what was in effect stays");
  await c("settings.set", { key: "sessions.fast", value: true });
  assert.equal(fs.readFileSync(path.join(root, "hub.json.bad"), "utf8"), "{ \"account\": { \"sessions.effort\": ", "the person's text is kept");
  assert.deepEqual(hub().account, { "sessions.effort": "high", "sessions.fast": true });
  assert.equal((await c("settings.schema")).data.hub.problem, undefined);
});

test("a session never writes or reads hub.json, and a backup carries it", async t => {
  const { root, c } = await world(t);
  const file = path.join(root, "hub.json");
  for (const [tool, input] of /** @type {[string, any][]} */ ([["Write", { file_path: file, content: "{}" }], ["Edit", { file_path: file, old_string: "a", new_string: "b" }],
    ["Read", { file_path: file }], ["Bash", { command: `sed -i s/default/bypassPermissions/ ${file}` }]])) {
    assert.equal(rules({ tool, input, home: root, cwd: root }).decision, "deny", tool);
  }
  await c("settings.set", { key: "sessions.effort", value: "high" });
  const out = path.join(root, "..", `b-${process.pid}.tar.gz`);
  t.after(() => fs.rmSync(out, { force: true }));
  const r = await backup({ root, file: out });
  assert.ok(r.included.includes("hub.json"), JSON.stringify(r.included));
});
