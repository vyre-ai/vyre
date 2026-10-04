// @ts-check
// `vyre assistant` as a surface runs it: the real bin/vyre in a child process against a box vyred
// in this process in a temp home. It takes no verbs, only a name; with none and no assistant yet
// it prints null under --json and says how to make one under --view.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome, present } from "../../../test/helpers.js";
import { slug } from "./assistant.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, stdout: string, all: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, stdout, all: stdout + stderr })));

test("assistant: no verbs, one optional name, in vyre commands", async t => {
  const c = JSON.parse((await run(tempHome(t), ["commands", "assistant", "--json"])).stdout).commands[0];
  assert.deepEqual(c.verbs, []);
  assert.deepEqual(c.args, [{ name: "name", required: false }]);
  assert.equal(slug("Juno Two"), "juno-two");
});

test("assistant --json and --view with no assistant yet: null, and the words that make one", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const j = await run(root, ["assistant", "--json"]);
  assert.equal(j.code, 0, j.all);
  assert.equal(JSON.parse(j.stdout), null);
  const f = (await run(root, ["assistant", "--view"])).stdout.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].data], ["assistant", "text", null]);
  assert.match(f[0].view.lines[0], /vyre assistant Juno/);
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 0 });
});
