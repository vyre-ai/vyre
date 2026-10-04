// @ts-check
// What Claude Code on this computer is GIVEN, on a real daemon with the kernel on (reviewer-3's PG-1, PG-2, PG-4): the grant names memory and recall reads, the sessions of the person's projects and
// memory.remember (a pending suggestion); every other tool, read or write, is refused with `not_in_grant`, decided in core/pluginagent. A decline or a revoke means no until the person turns it back on,
// an ask nobody answers expires after 24 h and the next waits 7 days, one ask is pending at a time, and an expired ask cannot be granted.
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
const HOUR = 3600_000;

test("the grant names exactly what it gives; a decline, a revoke and an expiry each mean no until the person says otherwise", { timeout: 180_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ recall: { every: 0 } }));
  const d = await start({ root, log: () => {}, kernel: true, presence: present, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const opts = { root };
  const proof = { root, headers: { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ method: "stand-in" })).toString("base64url") } };
  /** Time passes for the module: its asks are older by `ms` (the module reads the clock itself, so the test moves the rows). */
  const age = (/** @type {number} */ ms) => { const db = new DatabaseSync(path.join(root, "vyre.db")); db.exec("PRAGMA busy_timeout=10000"); db.prepare("UPDATE pluginagent_asks SET asked_at = asked_at - ?").run(ms); db.close(); };
  const ask = async () => (await call("pluginagent.ask", {}, { root, caller: "mcp" })).data;

  // One pending ask at a time, named by the daemon; a decline is no, and it stays no.
  const first = await ask();
  assert.equal(first.state, "waiting");
  assert.equal((await ask()).id, first.id, "the same ask, not a second");
  const pend = (await call("pluginagent.pending", {}, opts)).data;
  assert.equal(pend.length, 1);
  assert.ok(!/alex-laptop/.test(pend[0].sentence) && pend[0].computer.length > 0);
  assert.ok(!(await call("pluginagent.decline", {}, opts)).error);
  assert.equal((await ask()).state, "declined", "after a decline the plugin does not ask again");
  assert.equal((await ask()).state, "declined");
  assert.deepEqual((await call("pluginagent.pending", {}, opts)).data, []);
  assert.equal((await call("pluginagent.decline", {}, { root, caller: "mcp" })).error.code, "denied", "a model cannot decline for the person either way");
  assert.ok(!(await call("pluginagent.on", {}, opts)).error);
  const second = await ask();
  assert.equal(second.state, "waiting", "turned back on, it asks again");

  // An ask nobody answers expires at 24 h and cannot be granted; the next ask waits 7 days.
  age(25 * HOUR);
  const stale = await call("pluginagent.grant", { id: second.id }, proof);
  assert.equal(stale.error && stale.error.code, "expired", JSON.stringify(stale));
  assert.equal((await ask()).state, "quiet", "no new ask right after an expiry");
  age(6 * 24 * HOUR);
  assert.equal((await ask()).state, "quiet", "still quiet on day 7 minus a little");
  age(2 * 24 * HOUR);
  const third = await ask();
  assert.equal(third.state, "waiting", "asks again after the quiet days");

  // Granted: exactly the named reach.
  const g = await call("pluginagent.grant", { id: third.id }, proof);
  assert.ok(!g.error, JSON.stringify(g));
  const { agent, key } = JSON.parse(fs.readFileSync(path.join(root, "plugin-agent.json"), "utf8"));
  const as = { root, caller: `mcp:agent:${agent}`, headers: { "x-vyre-agent-key": key } };
  assert.ok(!(await call("memory.profile", {}, as)).error, "reads memory");
  assert.ok(!(await call("recall.search", { q: "x" }, as)).error, "reads recall");
  assert.ok(!(await call("projects.list", {}, as)).error, "reads the projects");
  const rem = await call("memory.remember", { text: "my wife is Jordan" }, as);
  assert.equal(rem.data && rem.data.pending, true, "its one write is a pending suggestion");
  for (const [tool, input] of [["google.calendar.today", {}], ["vault.list", {}], ["settings.set", { key: "x", value: 1 }], ["planner.add", { kind: "reminder", title: "x", at: Date.now() + 1000 }], ["mail.accounts", {}], ["link.call", { tool: "vault.list", input: {} }], ["memory.pin", { node: "x" }], ["memory.write", { text: "x", project: "p" }], ["sessions.accounts.signin", {}], ["flows.kit.propose", {}]]) {
    const r = await call(tool, input, as);
    assert.equal(r.error && r.error.code, "not_in_grant", `${tool}: ${JSON.stringify(r).slice(0, 160)}`);
  }

  // What it is offered is what it is given: the tool listing holds nothing else, and no other route (events) opens.
  const offered = await request("GET", "/v1/tools", undefined, as);
  const names = (offered.data || []).map((/** @type {any} */ x) => x.name);
  assert.ok(names.includes("memory.profile") && names.includes("recall.search"), "lists what it is given");
  assert.ok(names.every((/** @type {string} */ n) => /^(memory|recall|projects|threads|pluginagent)\./.test(n)), "lists only that: " + names.filter((/** @type {string} */ n) => !/^(memory|recall|projects|threads|pluginagent)\./.test(n)).slice(0, 5));
  assert.equal((await request("GET", "/v1/events?since=0", undefined, as)).error.code, "not_in_grant");

  // Revoke is no, too: the key is dead and the plugin does not ask again until the person turns it back on.
  assert.ok(!(await call("pluginagent.revoke", {}, proof)).error);
  assert.equal((await ask()).state, "declined");
  assert.equal((await call("memory.profile", {}, as)).error.code, "denied");
});
