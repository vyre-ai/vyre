// @ts-check
// `vyre vitals` as a person runs it: the real bin/vyre in a child process, against a server vyred in
// this process in a temp home. Read only, no presence needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome, present } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

test("vitals: status, explain and advice, each with --json, before and after a tick", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "local", transcripts: [], vault: { keystore: "file" },
    modules: { disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);

  // No sample yet: status says so rather than crashing.
  const empty = await vyre("vitals", "status");
  assert.equal(empty.code, 0, empty.out);
  assert.match(empty.out, /no sample yet/);

  // Force one tick through the module directly (the daemon's own timer would take up to 60s).
  const mod = /** @type {any} */ (d).registry.modules.get("vitals");
  await mod.handle.tick();

  const st = await vyre("vitals", "status");
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /cpu \d+%|cpu\s+—/);
  const sj = JSON.parse((await vyre("vitals", "status", "--json")).out);
  assert.equal(sj.device, "test-box");
  assert.ok(sj.latest);
  assert.ok(Array.isArray(sj.history));

  const ex = await vyre("vitals", "explain");
  assert.equal(ex.code, 0, ex.out);
  const ej = JSON.parse((await vyre("vitals", "explain", "--json")).out);
  assert.equal(ej.device, "test-box");
  assert.deepEqual(ej.trouble, []);

  const adv = await vyre("vitals", "advice");
  assert.equal(adv.code, 0, adv.out);
  const aj = JSON.parse((await vyre("vitals", "advice", "--json")).out);
  assert.deepEqual(aj, { device: "test-box", advice: [] }, "one tick is not thirty days of breaches");

  const bad = await vyre("vitals", "frob");
  assert.equal(bad.code, 2, "a usage mistake");
  assert.match(bad.out, /vyre vitals \[status\|explain\|advice\]/);
});

test("vitals: vyre commands lists every verb, all read only", async t => {
  const root = tempHome(t);
  const d = JSON.parse((await run(root, ["commands", "vitals", "--json"])).out);
  const verbs = d.commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["status", "explain", "advice"]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["status", "explain", "advice"]);
  assert.equal(verbs.some(v => v.person), false, "vitals never needs presence to read");
});
