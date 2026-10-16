// @ts-check
// The hosted door (POST /mcp, core/mcpconn) is an ALLOWLIST by tool name (core/modules/agent-reach.js HOSTED_ALLOW), with HOSTED_NEVER as a second wall. This pins it: the set a hosted key can use,
// computed over every tool the registry holds, equals core/modules/hosted-allow.json exactly; no listed name is stale; nothing that can run code, drive a screen, install or make a key
// is in it; and every tool in the work-surface families is either allowed or named in the reviewed refused list, so a NEW tool there fails here until someone classifies it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { HOSTED_ALLOW, HOSTED_NEVER, HOSTED_GATE, hostedKeyMay } from "../core/modules/agent-reach.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const REFUSED = path.join(path.dirname(new URL(import.meta.url).pathname), "hosted-refused.json");
const ALLOW = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "core", "modules", "hosted-allow.json");
const FAMILIES = /^(records|projects|work\.chat|threads|files|flows|tasks|approvals|memory|recall|comms|mail|mentions)\./;
const RISKY = /shell|exec|install|passkey|spawn|desktop|computer|chrome|glass|screen|hands|vault|credential|device/;

test("hosted door: the allowed set equals the reviewed allowlist exactly, and a new tool in a work family must be classified", { timeout: 180_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ recall: { every: 0 } }));
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const file = JSON.parse(fs.readFileSync(ALLOW, "utf8")).allow;
  const reviewed = { allow: Object.keys(file), refused: JSON.parse(fs.readFileSync(REFUSED, "utf8")).refused };
  for (const [n, why] of Object.entries(file)) assert.ok(typeof why === "string" && why.length > 20, `${n} says why a hosted key may use it`);
  const all = [...d.registry.tools.keys()].sort();
  const allowed = all.filter(hostedKeyMay);
  const gate = [...HOSTED_GATE].filter(n => all.includes(n));
  assert.deepEqual(allowed, [...new Set([...reviewed.allow, ...gate])].sort(), "the hosted set is the reviewed allowlist plus the exact Gate proposals");
  assert.deepEqual([...HOSTED_ALLOW].filter(n => !all.includes(n)), [], "no allowlisted name is stale");
  assert.deepEqual([...HOSTED_GATE].filter(n => !all.includes(n)), [], "no Gate name is stale");
  assert.deepEqual(allowed.filter(n => RISKY.test(n) && !HOSTED_GATE.has(n)), [], "nothing that runs code, drives a screen, installs, or touches credentials or devices is allowed outside the Gate list");
  const declaredGate = Object.keys(JSON.parse(fs.readFileSync(ALLOW, "utf8")).gate).sort();
  assert.deepEqual([...HOSTED_GATE].sort(), declaredGate, "the gate is the declared allowlist and nothing else");
  assert.equal(HOSTED_GATE.has("identity.unlock"), false, "unlocking stays off the hosted gate");
  assert.equal(hostedKeyMay("vault.space.use"), false, "lending is not a hosted proposal");
  assert.equal(hostedKeyMay("vault.put"), false);
  assert.equal(hostedKeyMay("spaces.identity.create"), false);
  for (const n of HOSTED_GATE) assert.equal(d.registry.tools.get(n).outward, true, `${n} is held: its manifest marks it outward`);
  for (const list of Object.values(HOSTED_NEVER)) for (const p of list) assert.ok(!allowed.some(n => n.startsWith(p) && !HOSTED_GATE.has(n)), `the second wall holds: ${p}`);
  const unclassified = all.filter(n => FAMILIES.test(n) && !reviewed.allow.includes(n) && !reviewed.refused.includes(n));
  assert.deepEqual(unclassified, [], "a tool in a work family is neither allowed nor reviewed-refused: classify it in core/modules/hosted-allow.json or test/hosted-refused.json");
  assert.deepEqual(reviewed.refused.filter((/** @type {string} */ n) => !all.includes(n)), [], "no refused name is stale");
});
