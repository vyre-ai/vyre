// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTED_GATE, HOSTED_GATE_REASONS, hostedKeyMay } from "../core/modules/agent-reach.js";

const file = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "core", "modules", "hosted-allow.json"), "utf8"));

test("HOSTED_GATE is the declared gate allowlist and nothing else", () => {
  assert.deepEqual([...HOSTED_GATE].sort(), Object.keys(file.gate).sort());
  assert.deepEqual(HOSTED_GATE_REASONS, file.gate);
  for (const why of Object.values(file.gate)) assert.equal(typeof why, "string");
  assert.equal(HOSTED_GATE.has("identity.unlock"), false);
  assert.equal(HOSTED_GATE.has("vault.space.use"), false);
  assert.equal(hostedKeyMay("identity.unlock"), false);
  assert.equal(hostedKeyMay("vault.space.use"), false);
  assert.equal(hostedKeyMay("vault.put"), false);
  assert.equal(hostedKeyMay("vault.request"), false);
  assert.equal(hostedKeyMay("spaces.identity.create"), false);
  assert.equal(hostedKeyMay("spaces.devices.list"), false);
  assert.equal(hostedKeyMay("identity.create"), true);
  assert.equal(hostedKeyMay("spaces.members.remove"), true);
});
