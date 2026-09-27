// @ts-check
// `vyre memory mute` as a person runs it: the real bin/vyre in a child process, against a vyred in
// this process in a temp home whose Recall index holds the synthetic corpus (test/fixtures), so
// memory has Harlow Legal, Northwind Bakery and Sam Okafor to steer. No model, no real sessions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { open } from "../../store/index.js";
import { seedRecall } from "../../../test/fixtures/corpus.js";
import { tempHome, present } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string, stdout: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr, stdout })));

/** Every stdout line of a --view run, parsed as a frame. @param {string} s */
const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

/** A vyred in a temp home whose memory has been curated from the synthetic corpus. */
async function world(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "no-transcripts")], vault: { keystore: "file" }, modules: { disable: ["learn"] } }));
  const db = open(path.join(root, "vyre.db"));
  seedRecall(db);
  db.close();
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  assert.ok((await call("memory.curate", {}, { root })).data.nodes > 0);
  return (/** @type {string[]} */ ...args) => run(root, args);
}

test("memory mute: a node is muted and unmuted, the about view says so, and a missing node is a usage mistake", async t => {
  const vyre = await world(t);

  const muted = await vyre("memory", "mute", "Sam", "Okafor");
  assert.equal(muted.code, 0, muted.out);
  assert.match(muted.out, /Sam Okafor\s+muted/);
  const about = JSON.parse((await vyre("memory", "Sam Okafor", "--json")).out);
  assert.equal(about.about.muted, true);

  const back = await vyre("memory", "mute", "Sam Okafor", "--off", "--json");
  assert.equal(back.code, 0, back.out);
  assert.deepEqual(JSON.parse(back.out).mode, null);
  assert.equal(JSON.parse((await vyre("memory", "Sam Okafor", "--json")).out).about.muted, false);
  assert.match((await vyre("memory", "mute", "Sam Okafor", "--off")).out, /Sam Okafor\s+back to normal/);
  assert.match((await vyre("memory", "pin", "Sam Okafor")).out, /Sam Okafor\s+pinned/);

  const none = await vyre("memory", "mute");
  assert.equal(none.code, 2);
  assert.match(none.out, /vyre memory mute needs a node/);
  assert.match(none.out, /vyre memory mute <node> \[--off\]/);
  const nothing = await vyre("memory", "mute", "Juno Nobody", "--json");
  assert.equal(nothing.code, 1);
  assert.match(JSON.parse(nothing.out).error.message, /nothing in memory/);
});

test("memory cli: vyre commands lists every verb run() handles, and why's flags, without vyred", async t => {
  const root = tempHome(t);
  const r = await run(root, ["commands", "memory", "--json"]);
  assert.equal(r.code, 0, r.out);
  const verbs = JSON.parse(r.stdout).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["about", "ask", "correct", "corrections", "uncorrect", "merge", "split", "pin", "mute"]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["about", "ask", "corrections"]);
  assert.deepEqual(verbs.find(v => v.verb === "about").args, [{ name: "thing", required: false, repeat: true }]);
  const why = JSON.parse((await run(root, ["commands", "why", "--json"])).stdout).commands[0];
  assert.deepEqual(why.verbs, []);
  assert.deepEqual(why.flags.map(f => f.name), ["project", "json"]);
});

test("memory cli: --view draws the overview and one thing as tables of facts; about <thing> is the same as memory <thing>", async t => {
  const vyre = await world(t);
  const a = await vyre("memory", "about", "Sam", "Okafor", "--view");
  assert.equal(a.code, 0, a.out);
  const f = frames(a.stdout);
  assert.deepEqual([f[0].cmd, f[0].view.kind], ["memory about", "table"]);
  assert.match(f[0].view.title, /^Sam Okafor/);
  assert.deepEqual(f[0].view.columns.map(c => c.key), ["text", "confidence", "source", "age"]);
  assert.ok(f[0].view.rows.length && f[0].view.rows.every(r => r.id), "each row keeps its fact's id");
  assert.deepEqual(f[0].data, JSON.parse((await vyre("memory", "Sam Okafor", "--json")).stdout));
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 0 });

  const o = frames((await vyre("memory", "--view")).stdout);
  assert.equal(o[0].view.kind, "table");
  assert.match(o[0].view.title, /^\d+ facts · \d+ things · \d+ sessions read/);
  assert.deepEqual(o[0].data, JSON.parse((await vyre("memory", "about", "--json")).stdout), "about with no thing is the overview");
});
