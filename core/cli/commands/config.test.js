// @ts-check
// `vyre config` as a person runs it: the real bin/vyre in a child process, against a vyred in
// this process in a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

test("vyre config: list, set at account and project level, get, reset, and a bad value", async t => {
  const root = tempHome(t);
  const home = path.join(root, "projects", "northwind");
  fs.mkdirSync(path.join(home, ".vyre"), { recursive: true });
  fs.writeFileSync(path.join(home, ".vyre", "project.json"), JSON.stringify({ name: "Northwind Bakery", slug: "northwind" }));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, projectsDir: path.join(root, "projects"), settings: { claude_dir: path.join(root, "claude") } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const vyre = (/** @type {string[]} */ ...a) => run(root, a);

  let r = await vyre("config", "list", "sessions");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /sessions\.send_while_busy\s+steer\s+·\s+default/);

  r = await vyre("config", "set", "sessions.send_while_busy", "queue");
  assert.equal(r.code, 0, r.out);
  r = await vyre("config", "set", "sessions.send_while_busy", "interrupt", "--project", "northwind");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /interrupt\s+·\s+project/);

  r = await vyre("config", "get", "sessions.send_while_busy", "--project", "northwind", "--json");
  const got = JSON.parse(r.out);
  assert.deepEqual([got.value, got.source, got.account], ["interrupt", "project", "queue"]);

  r = await vyre("config", "reset", "sessions.send_while_busy", "--project", "northwind");
  assert.match(r.out, /queue\s+·\s+account/);

  r = await vyre("config", "set", "sessions.idle_minutes", "0");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /at least 1/);

  r = await vyre("config", "set", "nope.nothing", "1", "--json");
  assert.equal(JSON.parse(r.out).error.code, "not_found");
});
