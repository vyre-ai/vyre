// @ts-check
// The golden replay (roadmap 0.6 item 5): each step kind's scenario and the compound shapes, run to their end, give a ledger (scrubbed of ids) that is the same every time and the same as the golden file. A later
// change to the runner that moves a byte of it fails here and says which scenario; if the change is meant, `node kernel/flows/golden/write.mjs` writes the new file (golden-refresh does it in CI), and the diff is
// what a reviewer reads.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, ledger, runScenario } from "./safety-net.js";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "replay.json");
const record = async (/** @type {string} */ name) => { const r = await runScenario(name); return { ledger: ledger(r.root), runs: r.runs.length, world: JSON.parse(r.fingerprint) }; };

test("replay: a scenario's run is the same every time", { timeout: 240_000 }, async () => {
  for (const name of Object.keys(SCENARIOS)) {
    const a = await record(name), b = await record(name);
    assert.deepEqual(a, b, `${name}: two runs of the same scenario differ (an id or a time got into the ledger)`);
  }
});

test("replay: every scenario's ledger is the golden file's", { timeout: 240_000 }, async () => {
  assert.ok(fs.existsSync(FILE), "kernel/flows/golden/replay.json is missing: node kernel/flows/golden/write.mjs writes it");
  const golden = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(SCENARIOS).sort(), "the golden file and the scenarios name the same things");
  for (const name of Object.keys(SCENARIOS)) assert.deepEqual(JSON.parse(JSON.stringify(await record(name))), golden[name], `${name}: the replay differs from the golden file`);
});
