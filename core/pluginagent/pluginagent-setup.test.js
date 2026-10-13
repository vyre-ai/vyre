// @ts-check
// Set up mode: the person lets Claude Code on this computer set their space up and bring sessions in, for a few hours, with one yes.
// Before it and after it (ended, revoked, expired) the grant is exactly the read-only reach it always was.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("Set up mode: off by default, needs the grant and the person, widens the listing for its hours only", { timeout: 180_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ recall: { every: 0 } }));
  const d = await start({ root, log: () => {}, kernel: true, presence: present, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const opts = { root };
  const proof = { root, headers: { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ method: "stand-in" })).toString("base64url") } };
  const allowed = async (/** @type {string[]} */ tools) => (await d.registry.call("pluginagent.allows", { tools }, "module:vyred")).data.allowed;
  const TOOLS = ["projects.create", "records.define", "import.sessions.list", "import.sessions.run", "memory.profile"];

  // No grant yet: Set up mode cannot be turned on, and the model cannot turn it on either way.
  assert.equal((await call("pluginagent.setup.begin", {}, proof)).error.code, "conflict");
  const ask = (await call("pluginagent.ask", {}, { root, caller: "mcp" })).data;
  assert.ok(!(await call("pluginagent.grant", { id: ask.id }, proof)).error);
  const { agent, key } = JSON.parse(fs.readFileSync(path.join(root, "plugin-agent.json"), "utf8"));
  const as = { root, caller: `mcp:agent:${agent}`, headers: { "x-vyre-agent-key": key } };
  assert.equal((await call("pluginagent.setup.begin", {}, { root, caller: "mcp" })).error.code, "denied", "a model never turns it on");
  assert.equal((await call("pluginagent.setup.begin", {}, as)).error.code, "not_in_grant", "nor does Claude Code itself");
  assert.deepEqual(await allowed(TOOLS), ["memory.profile"], "granted but not in Set up mode: reads only");
  assert.equal((await call("import.sessions.list", {}, as)).error.code, "not_in_grant");

  // On: the listing and the daemon's check widen, the person's yes is recorded with its end.
  const on = await call("pluginagent.setup.begin", {}, proof);
  assert.ok(!on.error && on.data.on === true, JSON.stringify(on));
  assert.ok(Math.abs(on.data.hours - 4) < 0.01, "four hours unless said");
  assert.deepEqual((await allowed(TOOLS)).sort(), [...TOOLS].sort());
  assert.notEqual((await call("import.sessions.list", {}, as)).error?.code, "not_in_grant", "reaches the tool (the tool decides the rest)");
  const names = ((await request("GET", "/v1/tools", undefined, as)).data || []).map((/** @type {any} */ x) => x.name);
  assert.ok(names.includes("import.sessions.list"), "offered while on");
  assert.equal((await call("pluginagent.setup.status", {}, as)).data.on, true);
  for (const bad of ["vault.list", "settings.set", "pluginagent.grant"]) assert.equal((await call(bad, {}, as)).error.code, "not_in_grant", `${bad} stays out`);

  // Ended by Claude Code itself (narrowing is always safe), then by the clock, then by a revoke.
  assert.equal((await call("pluginagent.setup.end", {}, as)).data.was, true);
  assert.deepEqual(await allowed(TOOLS), ["memory.profile"]);
  assert.ok(!(await call("pluginagent.setup.begin", { hours: 1 }, proof)).error);
  const db = new DatabaseSync(path.join(root, "vyre.db")); db.exec("PRAGMA busy_timeout=10000");
  db.prepare("UPDATE pluginagent_state SET v = ? WHERE k = 'setup_until'").run(String(Date.now() - 1000)); db.close();
  assert.deepEqual(await allowed(TOOLS), ["memory.profile"], "the clock ends it, not a sweep");
  assert.equal((await call("pluginagent.setup.status", {}, as)).data.on, false);
  assert.ok(!(await call("pluginagent.setup.begin", { hours: 2 }, proof)).error);
  assert.ok(!(await call("pluginagent.revoke", {}, proof)).error);
  assert.deepEqual(await allowed(TOOLS), ["memory.profile"], "a revoke takes Set up mode with it (the key is dead too)");
  assert.equal((await d.registry.call("pluginagent.setup.status", {}, "module:vyred")).data.on, false);
});
