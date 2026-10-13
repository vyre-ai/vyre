// @ts-check
// The hosted door (POST /mcp, core/mcpconn) is an ALLOWLIST by tool name (core/modules/agent-reach.js HOSTED_ALLOW), with HOSTED_NEVER as a second wall. This pins it: the set a hosted key can use,
// computed over every tool the registry holds, equals the reviewed list in test/hosted-allow.json exactly; no listed name is stale; nothing that can run code, drive a screen, install or make a key
// is in it; and every tool in the work-surface families is either allowed or named in the reviewed refused list, so a NEW tool there fails here until someone classifies it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { HOSTED_ALLOW, HOSTED_NEVER, hostedKeyMay } from "../core/modules/agent-reach.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const FILE = path.join(path.dirname(new URL(import.meta.url).pathname), "hosted-allow.json");
const FAMILIES = /^(records|projects|work\.chat|threads|files|flows|tasks|approvals|memory|recall|comms|mail|mentions)\./;
const RISKY = /shell|exec|install|passkey|spawn|desktop|computer|chrome|glass|screen|hands|vault|credential|device/;

test("hosted door: the allowed set equals the reviewed allowlist exactly, and a new tool in a work family must be classified", { timeout: 180_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ recall: { every: 0 } }));
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const reviewed = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const all = [...d.registry.tools.keys()].sort();
  const allowed = all.filter(hostedKeyMay);
  assert.deepEqual(allowed, [...reviewed.allow].sort(), "the hosted set is exactly the reviewed allowlist (edit test/hosted-allow.json with the code, in review)");
  assert.deepEqual([...HOSTED_ALLOW].filter(n => !all.includes(n)), [], "no allowlisted name is stale");
  assert.deepEqual(allowed.filter(n => RISKY.test(n)), [], "nothing that runs code, drives a screen, installs, or touches credentials or devices is allowed");
  for (const list of Object.values(HOSTED_NEVER)) for (const p of list) assert.ok(!allowed.some(n => n.startsWith(p)), `the second wall holds: ${p}`);
  const unclassified = all.filter(n => FAMILIES.test(n) && !reviewed.allow.includes(n) && !reviewed.refused.includes(n));
  assert.deepEqual(unclassified, [], "a tool in a work family is neither allowed nor reviewed-refused: classify it in test/hosted-allow.json");
  assert.deepEqual(reviewed.refused.filter((/** @type {string} */ n) => !all.includes(n)), [], "no refused name is stale");
});
