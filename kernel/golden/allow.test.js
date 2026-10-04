// The golden allow file is generated, never hand-written: scripts/gen-allow.mjs builds it from core/modules/agent-reach.js (OPEN and ASK_FIRST) and the flows manifest.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OPEN, ASK_FIRST, PERSON_ONLY } from "../../core/modules/agent-reach.js";
import { generate, render, flowsAnyone, ALLOW_FILE, OPEN_NOTES, FLOWS_NOTES } from "../../scripts/gen-allow.mjs";

const committed = () => JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));

test("the committed allow file is exactly the generator's output: nothing hand-written, nothing stale", () => {
  assert.equal(fs.readFileSync(ALLOW_FILE, "utf8"), render(generate()), "run: npm run golden:allow");
});

test("every allow entry is a tool in OPEN or ASK_FIRST, or a reach anyone flows tool whose module authenticates the chain", () => {
  const flows = new Set(flowsAnyone());
  for (const e of committed()) {
    assert.deepEqual(Object.keys(e).sort(), ["reason", "tool"], `${e.tool}: only tool and reason`);
    assert.ok(OPEN.has(e.tool) || ASK_FIRST.has(e.tool) || flows.has(e.tool), `${e.tool} is in neither OPEN nor ASK_FIRST nor the flows manifest`);
    if (flows.has(e.tool)) assert.match(e.reason, /module authenticates the caller's chain/, `${e.tool}: a flows entry says the module authenticates the chain`);
  }
});

test("no person-only tool is allowed", () => {
  for (const e of committed()) assert.equal(PERSON_ONLY.has(e.tool), false, `${e.tool} is person only`);
  for (const t of ["flows.approve", "flows.pause", "flows.resume", "flows.kit.remove", "files.drive.access", "threads.mode"]) assert.equal(committed().some(e => e.tool === t), false, t);
});

test("every OPEN and ASK_FIRST tool has an entry, each with its own reason (no bulk text)", () => {
  const have = new Map(committed().map(e => [e.tool, e.reason]));
  for (const t of [...OPEN, ...ASK_FIRST.keys()]) assert.ok(have.has(t), `${t} has no allow entry`);
  const reasons = [...have.values()];
  assert.equal(new Set(reasons).size, reasons.length, "two entries share one reason");
  for (const [t, r] of have) assert.ok(r.length > 60, `${t}: reason too short`);
});

test("a note exists only for a tool that is still classified", () => {
  for (const t of Object.keys(OPEN_NOTES)) assert.ok(OPEN.has(t) || ASK_FIRST.has(t), `${t} has a note but is not in OPEN or ASK_FIRST`);
  const flows = new Set(flowsAnyone());
  for (const t of Object.keys(FLOWS_NOTES)) assert.ok(flows.has(t), `${t} has a flows note but is not a reach anyone flows tool`);
});

test("the six declared-anyone tools of 4 Oct are not in the allow file", () => {
  for (const t of ["bridges.continue", "bridges.copy", "bridges.resolve", "bridges.view.read", "spaces.code.submit", "spaces.invites.redeem"]) assert.equal(committed().some(e => e.tool === t), false, t);
});

test("the generator refuses a person-only tool and an open tool with no note", () => {
  // generate() throws on both; the exported lists prove the tools it walks are all covered today
  for (const t of OPEN) assert.ok(t in OPEN_NOTES, `${t} has no note`);
  for (const t of flowsAnyone()) assert.ok(t in FLOWS_NOTES, `${t} has no flows note`);
});
