// @ts-check
// `vyre send` as a person runs it: the real bin/vyre in a child process, against a computer-role vyred in this process in a temp home. A computer with no server paired
// answers in plain words, and a secret is refused before anything is looked up. The wire itself (sealing, the server's store, the receiver) is tested in core/files/drop-wink.test.js.

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

test("send: a computer with no server paired says so in words, a secret is refused first, --json prints what failed, and the command's own arguments are listed", async t => {
  const root = tempHome(t);
  // Outside the Vyre home: files never sends from inside it.
  const work = fs.mkdtempSync(path.join(SCRATCH, "vyre-send-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(work, "report.pdf"), "hello");
  fs.writeFileSync(path.join(work, ".env"), "KEY=1\n");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-mac", role: "local", transcripts: [], vault: { keystore: "file" },
    files: { roots: [work] }, modules: { disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);
  const report = path.join(work, "report.pdf"), secret = path.join(work, ".env");

  const one = await vyre("send", report);
  assert.equal(one.code, 1, one.out);
  assert.match(one.out, /○ .*report\.pdf · .*not paired to a server/);
  const both = await vyre("send", report, secret, "--to", "laptop", "--json");
  assert.equal(both.code, 1, "both failed");
  assert.equal(both.out.trim().split("\n").length, 1, both.out);
  const j = JSON.parse(both.out);
  assert.deepEqual(j.sent, []);
  assert.deepEqual(j.failed.map(x => [x.file, x.error.code]), [[report, "no_server"], [secret, "not_available"]], "the secret never gets as far as the server");
  const v = await vyre("send", report, "--view");
  const f = v.out.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.title], ["send", "table", "Sent with VyreDrop"]);
  const none = await vyre("send", "--json");
  assert.equal(none.code, 2, "no file is a usage mistake");
  assert.equal(JSON.parse(none.out).error.code, "bad_input");
  assert.match((await vyre("send")).out, /vyre send <file> \[more files\]/);
  const c = JSON.parse((await vyre("commands", "send", "--json")).out).commands[0];
  assert.deepEqual(c.verbs, []);
  assert.equal(c.args[0].name, "file");
});
