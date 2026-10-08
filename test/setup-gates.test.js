// @ts-check
// IR-11: what the setup page may call is one list. The relay's gate (core/relay/setup.js) and the registry's two checks of a setup caller (core/modules/index.js classReach, kernel/retrofit/gates.js)
// read it, and every tool the page calls goes through the real registry as a setup caller: none may answer "no such tool".
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { SETUP_TOOLS, SETUP_TOOL_FAMILIES, SETUP_REASONS, setupToolAllowed } from "../core/relay/setup.js";
import { SETUP_REACH } from "../core/modules/agent-reach.js";
import { classReach } from "../core/modules/index.js";
import { tempHome } from "./helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = "setup:" + "b".repeat(16);

/** Every tool name the app's add-a-server step calls on the box's setup channel. */
function pageTools() {
  const found = new Set();
  for (const m of fs.readFileSync(path.join(REPO, "apps", "app", "src", "real", "add-server.js"), "utf8").matchAll(/\bcall\(\s*"([a-z][a-z0-9.-]*\.[a-z0-9.-]+)"/g)) found.add(m[1]);
  return [...found].sort();
}

test("the setup page's tools are found, and each is on the one list the relay's gate and the registry's gates read", () => {
  const tools = pageTools();
  for (const t of ["system.info", "wink.server.setup-offer"]) assert.ok(tools.includes(t), `${t} is called by the add-a-server step`);
  const extra = [];
  for (const t of tools) {
    assert.equal(setupToolAllowed(t, extra), true, `${t}: the relay's gate lets it through`);
    assert.equal(classReach(SETUP, t, () => extra), true, `${t}: the registry's class check lets it through`);
  }
  // one list: every tool and family name the relay allows has a reason, and the registry's list is built from those reasons
  for (const t of SETUP_TOOLS) assert.ok(SETUP_REASONS.has(t), `${t} has no reason in SETUP_REASONS`);
  for (const [t] of SETUP_REASONS) {
    assert.ok(SETUP_TOOLS.has(t) || SETUP_TOOL_FAMILIES.some(r => r.test(t)), `${t} has a reason but the relay's gate does not allow it`);
    assert.ok(SETUP_REACH.has(t), `${t} is allowed by the relay but not reached by the registry`);
  }
  for (const bad of ["vault.get", "relay.pair.ticket", "network.wink.join", "presence.enroll"]) assert.equal(classReach(SETUP, bad, () => []), false, bad);
  for (const bad of ["vault.get", "relay.pair.ticket", "presence.enroll"]) assert.equal(classReach(SETUP, bad, () => [bad]), false, `${bad} is never taken, even if a module lists it`);
});

test("every tool the setup page calls goes through the real registry as a setup caller and none answers no_such_tool", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const refused = [];
  for (const tool of pageTools()) {
    const r = await d.registry.call(tool, {}, SETUP, {});
    // Whatever the tool answers to an empty call (a bad input, nothing to read) is its own; a refusal by the gates is "no_such_tool" or "denied".
    const code = r && r.error && r.error.code;
    if (code === "no_such_tool" || code === "denied") refused.push(`${tool}: ${code} ${r.error.message}`);
  }
  assert.deepEqual(refused, [], "the setup page's own calls were refused by a gate");
  const out = await d.registry.call("vault.get", {}, SETUP, {});
  assert.ok(out.error && ["no_such_tool", "denied"].includes(out.error.code), "a tool off the list stays refused");
});
