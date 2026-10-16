// @ts-check
// Install pairing tools: names and reach come from module manifests and agent-reach, not a hand-maintained list.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPEN } from "../core/modules/agent-reach.js";
import { PROVEN_NAMED_AGENT_CALLERS } from "../lib/proven-agent-callers.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} rel */
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

/** @param {string} mod */
function toolNames(mod) {
  const m = readJson(path.join("core", mod, "module.json"));
  return (m.does?.tools || []).map((/** @type {any} */ t) => (typeof t === "string" ? t : t.name)).filter(Boolean);
}

test("every wink install tool is open to a proven assistant and declared in wink only", () => {
  const wink = toolNames("wink").filter((n) => n.startsWith("wink.install."));
  assert.ok(wink.includes("wink.install.issue"));
  assert.ok(wink.includes("wink.install.status"));
  assert.ok(wink.includes("wink.install.complete"));
  const spaces = toolNames("spaces");
  assert.ok(!spaces.some((n) => n.startsWith("wink.install.")));
  for (const name of wink) {
    assert.ok(OPEN.has(name), `${name} is in agent-reach OPEN`);
    assert.equal(readJson("core/wink/module.json").does.tools.find((/** @type {any} */ t) => t.name === name)?.outward, name === "wink.install.status" ? undefined : true, name);
  }
});

test("spaces.pair.install covers the mint and onboard polls through wink.install.status", () => {
  const spaces = readJson("core/spaces/module.json");
  const pair = spaces.does.tools.find((/** @type {any} */ t) => t.name === "spaces.pair.install");
  assert.deepEqual(pair.covers, ["wink.install.issue"]);
  const onboard = toolNames("onboard");
  assert.ok(onboard.includes("onboard.space.open"));
  assert.ok(onboard.includes("onboard.space.poll"));
  const src = fs.readFileSync(path.join(ROOT, "core/onboard/first-run.js"), "utf8");
  assert.match(src, /wink\.install\.status/);
  assert.match(src, /resolveInstallOnline/);
  assert.doesNotMatch(src, /row\.online\s*=/);
});

test("proven named agent callers are listed for cross-provider Gate tests", () => {
  assert.ok(PROVEN_NAMED_AGENT_CALLERS.includes("mcp:agent:kit"));
  assert.ok(PROVEN_NAMED_AGENT_CALLERS.some((c) => c.includes("codex") || c.includes("grok")));
});
