// @ts-check
// `vyre send` as a person runs it: the real bin/vyre in a child process, against a Mac-role vyred
// in this process in a temp home. Sending whole files comes back with VyreDrop: until then files.send answers "unavailable" after the files guard has checked the path,
// and the command says so file by file. Nothing leaves this machine.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome, present } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");
const BOX_ID = "nBox000CNTRL";

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

test("send: one line per file, a refused file stays refused, and --json says what failed", async t => {
  const root = tempHome(t);

  // Outside the Vyre home: files never sends from inside it.
  const work = fs.mkdtempSync(path.join(SCRATCH, "vyre-send-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(work, "report.pdf"), "hello");
  fs.writeFileSync(path.join(work, ".env"), "KEY=1\n");
  // Paired, as `vyre link pair` leaves it, with a box at a loopback port nothing answers on, so the
  // link module's hello goes nowhere.
  fs.writeFileSync(path.join(root, "link.json"), JSON.stringify({ box: { address: "https://127.0.0.1:9", stableId: BOX_ID, node: "box", name: "box" },
    key: "fixture-key", peer: "fixture-peer", pairedAt: 0 }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-mac", role: "local", transcripts: [], vault: { keystore: "file" },
    files: { roots: [work] }, modules: { disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);
  const report = path.join(work, "report.pdf"), secret = path.join(work, ".env");

  const one = await vyre("send", report);
  assert.equal(one.code, 1, one.out);
  assert.match(one.out, /○ .*report\.pdf · .*VyreDrop/);
  assert.ok(!/tailscale|taildrop/i.test(one.out), "nothing names another product");

  const both = await vyre("send", report, secret, "--json");
  assert.equal(both.code, 1, "both failed");
  assert.equal(both.out.trim().split("\n").length, 1, both.out);
  const j = JSON.parse(both.out);
  assert.deepEqual(j.sent, []);
  assert.equal(j.failed.length, 2);
  assert.equal(j.failed[0].file, report);
  assert.equal(j.failed[0].error.code, "unavailable");
  assert.equal(j.failed[1].file, secret);
  assert.equal(j.failed[1].error.code, "not_available", "the files guard still refuses a secret before anything else");
  // --view: one table, a row per file, each failed; data is what --json printed.
  const v = await vyre("send", report, secret, "--view");
  assert.equal(v.code, 1);
  const f = v.out.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.title], ["send", "table", "Sent"]);
  assert.deepEqual(f[0].view.rows.map(r => [r.file, r.state]), [[report, "failed"], [secret, "failed"]]);
  assert.deepEqual(Object.keys(f[0].data), ["sent", "failed"]);
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 1 });

  const human = await vyre("send", secret);
  assert.equal(human.code, 1);
  assert.match(human.out, /○ .*\.env · /);
  const none = await vyre("send", "--json");
  assert.equal(none.code, 2, "no file is a usage mistake");
  assert.equal(JSON.parse(none.out).error.code, "bad_input");
  assert.match((await vyre("send")).out, /vyre send <file> \[more files\]/);
  // No verbs: every word is a file, so vyre commands gives its own arguments instead.
  const c = JSON.parse((await vyre("commands", "send", "--json")).out).commands[0];
  assert.deepEqual(c.verbs, []);
  assert.equal(c.args[0].name, "file");
});
