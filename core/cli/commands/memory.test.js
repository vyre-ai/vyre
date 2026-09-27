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

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

test("memory mute: a node is muted and unmuted, the about view says so, and a missing node is a usage mistake", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "no-transcripts")], vault: { keystore: "file" }, modules: { disable: ["learn"] } }));
  const db = open(path.join(root, "vyre.db"));
  seedRecall(db);
  db.close();
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  assert.ok((await call("memory.curate", {}, { root })).data.nodes > 0);
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);

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

test("memory ask: Vyre IQ answers from what the user said, with where; else not sure, exit 1", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "no-transcripts")], vault: { keystore: "file" }, modules: { disable: ["learn"] } }));
  const db = open(path.join(root, "vyre.db"));
  seedRecall(db);
  db.close();
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  await call("memory.curate", {}, { root });
  assert.ok((await call("memory.remember", { text: "my wife is Juno" }, { root })).data.facts.length > 0);
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);

  const wife = await vyre("memory", "ask", "what is my wife's name");
  assert.equal(wife.code, 0, wife.out);
  assert.match(wife.out, /Juno/);
  assert.match(wife.out, /confidence 0\.\d+ · from what you have said/);
  const j = JSON.parse((await vyre("memory", "ask", "what is my wife's name", "--json")).out);
  assert.equal(j.via, "fact");
  assert.equal(j.abstained, false);

  // No model under node --test: a question only a session could answer is not sure.
  const unsure = await vyre("memory", "ask", "which port did the Northwind staging deploy use");
  assert.equal(unsure.code, 1, unsure.out);
  assert.match(unsure.out, /not sure yet/);
  assert.equal((await vyre("memory", "ask")).code, 2);
});
