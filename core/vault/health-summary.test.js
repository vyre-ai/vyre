// @ts-check
// The vault's health for Now: counts from the daily Watchtower run's open reminders, none of it a name or a value, and zero while the person has dismissed it.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "./tools/deck.js";
import { REMIND_MIGRATION } from "./remind.js";

function rig() {
  const db = new DatabaseSync(":memory:");
  db.exec(REMIND_MIGRATION);
  /** @type {Record<string, any>} */ const tools = {};
  register({ ctx: { store: { db }, config: {}, tool: (/** @type {string} */ n, /** @type {any} */ d) => { tools[n] = d; } }, vault: /** @type {any} */ ({}) });
  const add = (/** @type {string} */ name, /** @type {string} */ reason, state = "open") => db.prepare("INSERT INTO vault_reminders (name, reason, planner, state, at) VALUES (?,?,?,?,1)").run(name, reason, null, state);
  return { db, tools, add };
}

test("open findings are counted as to rotate and to fix, with no name; done and dismissed ones are not", async () => {
  const { tools, add } = rig();
  assert.deepEqual((await tools["vault.health.summary"].run({})).total, 0, "nothing found, nothing shown");
  add("bank", "rotate"); add("github", "expiring"); add("mail", "reused"); add("shop", "reused"); add("old-one", "old", "done"); add("quiet", "reused", "dismissed");
  const s = await tools["vault.health.summary"].run({});
  assert.deepEqual([s.total, s.rotate, s.fix], [4, 2, 2]);
  assert.ok(!JSON.stringify(s).includes("bank") && !JSON.stringify(s).includes("github"), "counts only");
});

test("dismissing hides it for a while, and it comes back after", async () => {
  const { tools, add, db } = rig();
  add("bank", "rotate");
  const d = await tools["vault.health.dismiss"].run({ days: 3 });
  assert.ok(d.dismissed_until > Date.now());
  assert.equal((await tools["vault.health.summary"].run({})).total, 0, "hidden while dismissed");
  db.prepare("UPDATE vault_jobs SET at = ? WHERE name = 'health-dismiss'").run(Date.now() - 1000);
  assert.equal((await tools["vault.health.summary"].run({})).total, 1, "back once the time has passed");
});
