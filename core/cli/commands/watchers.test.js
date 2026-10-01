// @ts-check
// `vyre watchers test|create|pause|resume|logs` as a person runs them: the real bin/vyre in a
// child process, against a vyred in this process in a temp home, with a watcher that reads
// nothing from the network and files one item into a Harlow Legal project.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import * as config from "../../config/index.js";
import { tempHome, present } from "../../../test/helpers.js";
import { testHooks, OPEN_WALL } from "../../../lib/sandbox/index.js";
// These tests are about the flow around a watcher (the CLI, a hook delivery, a duty), not the wall, and a hosted
// runner has no bubblewrap profile: use the test seam. Production still fails closed (lib/sandbox/wall.js).
testHooks.wall = OPEN_WALL;

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 60_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

async function until(fn, what, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise(r => setTimeout(r, 50));
  }
}

test("watchers cli: test, create, logs, pause and resume one watcher, with --json on each", async t => {
  const root = tempHome(t);
  const p = config.ensure(root);
  fs.writeFileSync(p.config, JSON.stringify({ roots: [], transcripts: [path.join(root, "no-transcripts")], vault: { keystore: "file" }, modules: { disable: ["recall", "learn"] } }));
  const home = path.join(root, "harlow-legal");
  fs.mkdirSync(home);
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  assert.ok(!(await call("projects.create", { name: "Harlow Legal", home }, { root })).error);
  const dir = path.join(p.watchers, "harlow-intake");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify({ name: "harlow-intake", project: "harlow-legal", schedule: "@hourly", emits: "form.seen" }));
  fs.writeFileSync(path.join(dir, "watch.js"), `export default async function watch({ emit }) { emit({ id: "f-1", title: "New intake form from alex" }); }`);
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);

  const dry = await vyre("watchers", "test", "harlow-intake");
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /harlow-intake would file 1 items/);
  assert.match(dry.out, /New intake form from alex/);
  assert.match(dry.out, /vyre watchers create harlow-intake to turn it on/);
  const dj = JSON.parse((await vyre("watchers", "test", "harlow-intake", "--json")).out);
  assert.equal(dj.ok, true);
  assert.deepEqual(dj.items.map(i => i.title), ["New intake form from alex"]);

  // Each dry run is logged, as a "test" run that filed nothing.
  const tried = JSON.parse((await vyre("watchers", "logs", "harlow-intake", "--json")).out);
  assert.deepEqual(tried.map(r => [r.trigger, r.ok, r.items, r.filed]), [["test", true, 1, 0], ["test", true, 1, 0]]);
  assert.match((await vyre("watchers", "logs", "harlow-intake")).out, /ok .*test 1 seen · 0 filed/);

  const on = await vyre("watchers", "create", "harlow-intake");
  assert.equal(on.code, 0, on.out);
  assert.match(on.out, /harlow-intake on/);
  // Created runs once at once, and that run files the item.
  const first = await until(async () => JSON.parse((await vyre("watchers", "logs", "harlow-intake", "--json")).out).find(r => r.trigger !== "test"), "the first real run");
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.filed, 1);

  const paused = JSON.parse((await vyre("watchers", "pause", "harlow-intake", "--json")).out);
  assert.equal(paused.state, "paused");
  const listed = JSON.parse((await vyre("watchers", "--json")).out);
  assert.equal(listed.watchers.find(w => w.name === "harlow-intake").state, "paused");
  // --view: the list as a table, one row per watcher, with the data --json prints.
  const lv = (await vyre("watchers", "list", "--view")).out.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual([lv[0].cmd, lv[0].view.kind, lv[0].view.title], ["watchers list", "table", "Watchers"]);
  assert.deepEqual(lv[0].view.columns.map(c => c.key), ["name", "state", "project", "every", "items", "lastRun"]);
  assert.deepEqual(lv[0].view.rows.map(r => [r.name, r.state]), [["harlow-intake", "paused"]]);
  assert.deepEqual(lv[0].data.watchers.map(w => w.name), listed.watchers.map(w => w.name));
  assert.deepEqual(lv.at(-1), { v: 1, done: true, exit: 0 });
  const items = JSON.parse((await vyre("watchers", "items", "harlow-intake", "--json")).out);
  assert.deepEqual(items.map(i => i.title), ["New intake form from alex"]);
  const resumed = await vyre("watchers", "resume", "harlow-intake");
  assert.equal(resumed.code, 0, resumed.out);
  assert.match(resumed.out, /harlow-intake on/);

  for (const verb of ["test", "create", "pause", "resume", "logs"]) {
    const r = await vyre("watchers", verb);
    assert.equal(r.code, 2, `${verb} with no name is a usage mistake`);
    assert.match(r.out, new RegExp(`vyre watchers ${verb} needs a watcher's name`));
    assert.match(r.out, /vyre watchers lists them/);
  }
  const bad = await vyre("watchers", "frob");
  assert.equal(bad.code, 2);

  // vyre commands lists every verb run() takes, and each named verb is one it handles.
  const verbs = JSON.parse((await vyre("commands", "watchers", "--json")).out).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["list", "test", "create", "pause", "resume", "logs", "items"]);
  assert.deepEqual(verbs[0].aliases, ["ls"]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["list", "logs", "items"]);
  assert.deepEqual(verbs.find(v => v.verb === "pause")?.args, [{ name: "name", required: true }]);
  for (const v of verbs) assert.doesNotMatch((await vyre("watchers", v.verb, "northwind-orders")).out, /not a subcommand/, v.verb);
  const missing = await vyre("watchers", "pause", "northwind-orders", "--json");
  assert.equal(missing.code, 1);
  assert.ok(JSON.parse(missing.out).error.message);
});
