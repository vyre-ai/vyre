// @ts-check
// `vyre send` as a person runs it: the real bin/vyre in a child process, against a Mac-role vyred
// in this process in a temp home. The home is paired with a server on a dead loopback port, and
// tailscale is a fake that knows the server as a peer and records `file cp` instead of sending
// anything. Nothing leaves this machine.

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

const FAKE_TS = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n");
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ BackendState: "Running", Self: { ID: "nMac", DNSName: "mac.tail0000.ts.net." },
    Peer: { k0: { ID: "${BOX_ID}", DNSName: "box.tail0000.ts.net.", HostName: "box", TailscaleIPs: ["100.64.0.5"], Online: true, Tags: [], TaildropTarget: 1 } } }));
  process.exit(0);
}
if (args[0] === "file" && args[1] === "cp") process.exit(0);
process.exit(1);
`;

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

test("send: one line per file, and --json prints what was sent and what failed", async t => {
  const root = tempHome(t);
  const ts = path.join(root, "ts");
  fs.mkdirSync(ts);
  fs.writeFileSync(path.join(ts, "tailscale"), FAKE_TS, { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = path.join(ts, "tailscale");
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });

  // Outside the Vyre home: files never sends from inside it.
  const work = fs.mkdtempSync(path.join(SCRATCH, "vyre-send-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(work, "report.pdf"), "hello");
  fs.writeFileSync(path.join(work, ".env"), "KEY=1\n");
  // Paired, as `vyre link pair` leaves it, with a server at a loopback port nothing answers on, so the
  // link module's hello goes nowhere.
  fs.writeFileSync(path.join(root, "link.json"), JSON.stringify({ box: { address: "https://127.0.0.1:9", stableId: BOX_ID, node: "box.tail0000.ts.net", name: "box" },
    key: "fixture-key", peer: "fixture-peer", pairedAt: 0 }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-mac", role: "local", transcripts: [], vault: { keystore: "file" },
    files: { roots: [work] }, modules: { disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);
  const report = path.join(work, "report.pdf"), secret = path.join(work, ".env");

  const one = await vyre("send", report);
  assert.equal(one.code, 0, one.out);
  assert.match(one.out, /● report\.pdf\s+5 B · to box\.tail0000\.ts\.net/);
  const cp = fs.readFileSync(path.join(ts, "calls.log"), "utf8").trim().split("\n").map(l => JSON.parse(l)).find(a => a[0] === "file");
  assert.deepEqual(cp, ["file", "cp", fs.realpathSync(report), "100.64.0.5:"]);

  const both = await vyre("send", report, secret, "--json");
  assert.equal(both.code, 1, "one failed");
  assert.equal(both.out.trim().split("\n").length, 1, both.out);
  const j = JSON.parse(both.out);
  assert.deepEqual(j.sent, [{ file: report, sent: "report.pdf", bytes: 5, to: "box.tail0000.ts.net" }]);
  assert.equal(j.failed.length, 1);
  assert.equal(j.failed[0].file, secret);
  assert.equal(j.failed[0].error.code, "not_available");
  // --view: one table, a row per file, sent or failed; data is what --json printed.
  const v = await vyre("send", report, secret, "--view");
  assert.equal(v.code, 1);
  const f = v.out.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.title], ["send", "table", "Sent with Taildrop"]);
  assert.deepEqual(f[0].view.rows.map(r => [r.file, r.state]), [[report, "sent"], [secret, "failed"]]);
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
