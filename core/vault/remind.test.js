// @ts-check
// Rotation reminders (ADR 0028, decision 4): Watchtower's findings become planner todos once,
// a batch over five becomes one todo, a fixed item's todo is done, a dismissed one stays quiet,
// no planner means nothing happens, and the timer is due once a day after 09:00.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { recorded } from "./testing.js";
import { nextRun } from "./remind.js";

const hex = n => crypto.randomBytes(n).toString("hex");

/** A planner that keeps what it is given, as planner.add / get / done answer. */
function fakePlanner() {
  const items = new Map();
  let n = 0;
  const call = async (tool, input) => {
    if (tool === "planner.add") { const id = `p${++n}`; items.set(id, { id, state: "open", ...input }); return { data: { id } }; }
    if (tool === "planner.get") { const it = items.get(input.item); return it ? { data: { item: it } } : { error: { code: "not_found", message: "no" } }; }
    if (tool === "planner.done") { const it = items.get(input.item); if (it) it.state = "done"; return { data: { ok: true } }; }
    return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
  };
  return { items, call };
}

test("reminders: one todo per finding, never twice, done when fixed, quiet when dismissed", async t => {
  const planner = fakePlanner();
  const { run, db } = await recorded(t, { reminders: false }, { call: planner.call });
  const shared = hex(12);
  await run("vault.put", { name: "harlow-portal", kind: "login", fields: { username: "juno", password: shared } });
  await run("vault.put", { name: "northwind-orders", kind: "login", fields: { username: "kit", password: shared } });
  await run("vault.put", { name: "kit-github", kind: "pat", value: ["ghp", hex(18)].join("_"), details: { expires: Date.now() - 1000 } });
  await run("vault.put", { name: "harlow-tls", kind: "api-key", value: hex(16), details: { expires: Date.now() + 3 * 86400_000 } });

  const first = await run("vault.remind.run", {});
  assert.deepEqual(first.added.sort(), ["harlow-portal:reused", "harlow-tls:expiring", "kit-github:expired", "northwind-orders:reused"]);
  const titles = [...planner.items.values()].map(i => i.title).sort();
  assert.ok(titles.some(x => /^Renew the token for kit-github \(ended \d{4}-\d{2}-\d{2}\)$/.test(x)));
  assert.ok(titles.some(x => /^Change the password for harlow-portal$/.test(x)));
  assert.ok(titles.some(x => /^Renew the key for harlow-tls \(ends \d{4}-\d{2}-\d{2}\)$/.test(x)));
  for (const i of planner.items.values()) { assert.equal(i.list, "Vault"); assert.equal(i.kind, "todo"); assert.ok(i.tags.includes("vault")); }
  assert.equal([...planner.items.values()].find(i => i.title.includes("kit-github")).priority, 1);

  // A second run adds nothing.
  assert.deepEqual((await run("vault.remind.run", {})).added, []);
  assert.equal(planner.items.size, 4);

  // Fixed: a new password for northwind-orders ends the reuse for both; their todos are done.
  await run("vault.put", { name: "northwind-orders", kind: "login", fields: { username: "kit", password: hex(12) } });
  const third = await run("vault.remind.run", {});
  assert.deepEqual(third.closed.sort(), ["harlow-portal:reused", "northwind-orders:reused"]);
  const byTitle = t => [...planner.items.values()].find(i => i.title.includes(t));
  assert.equal(byTitle("harlow-portal").state, "done");
  assert.equal(byTitle("northwind-orders").state, "done");

  // Dismissed: the person cancelled the expired PAT's todo; it is not raised again.
  byTitle("kit-github").state = "cancelled";
  assert.deepEqual((await run("vault.remind.run", {})).added, []);
  assert.equal(db.prepare("SELECT state FROM vault_reminders WHERE name = 'kit-github'").get().state, "dismissed");
  assert.equal(planner.items.size, 4);
});

test("reminders: more than five at once become one todo listing them; no planner, nothing happens", async t => {
  const planner = fakePlanner();
  const { run } = await recorded(t, { reminders: false }, { call: planner.call });
  for (let i = 0; i < 7; i++) await run("vault.put", { name: `northwind-key-${i}`, kind: "api-key", value: hex(16), details: { expires: Date.now() - 1000 } });
  const r = await run("vault.remind.run", {});
  assert.equal(r.added.length, 7);
  assert.equal(planner.items.size, 1);
  const only = [...planner.items.values()][0];
  assert.equal(only.title, "Renew 7 credentials: expired");
  assert.equal(only.body.split("\n").length, 7);

  const none = await recorded(t, { reminders: false });
  await none.run("vault.put", { name: "juno-key", kind: "api-key", value: hex(16), details: { expires: Date.now() - 1000 } });
  assert.deepEqual(await none.run("vault.remind.run", {}), { added: [], closed: [], planner: false });
});

test("reminders: due once a day, the first 09:00 after the last run", () => {
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
  assert.equal(nextRun(null, at(5, 7)), at(5, 9));
  assert.equal(nextRun(null, at(5, 11)), at(5, 11) + 60_000, "vyred was off at nine: soon");
  assert.equal(nextRun(at(5, 9, 1), at(5, 15)), at(6, 9));
  assert.equal(nextRun(at(5, 9, 1), at(7, 8)), at(7, 8) + 60_000, "a day was missed: soon");
  assert.equal(nextRun(at(4, 23), at(5, 8)), at(5, 9));
});
