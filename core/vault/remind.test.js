// @ts-check
// Rotation reminders (ADR 0028, decision 4): Watchtower's findings become planner todos once,
// a batch over five becomes one todo, a fixed item's todo is done, a dismissed one stays quiet,
// no planner means nothing happens, and the timer is due once a day after 09:00.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { recorded } from "./testing.js";
import { nextRun, remindTick, BREACH_EVERY_MS } from "./remind.js";
import { BREACH_URL } from "./health.js";

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

/** A fake pwnedpasswords that flags exactly `flagged` by password value. */
function fakeBreachFetch(flagged) {
  const sha = s => crypto.createHash("sha1").update(s).digest("hex").toUpperCase();
  return async url => {
    const prefix = String(url).slice(BREACH_URL.length);
    const rows = ["0000000000000000000000000000000000A:0"];
    for (const pw of flagged) if (sha(pw).slice(0, 5) === prefix) rows.push(sha(pw).slice(5) + ":9");
    return new Response(rows.join("\r\n"));
  };
}

test("reminders: the breach check rides the daily tick, opted in, at most once a week", async t => {
  const planner = fakePlanner();
  const { run, vault, db } = await recorded(t, { reminders: false }, { call: planner.call });
  const pw = hex(12);
  await run("vault.put", { name: "old-forum", kind: "login", fields: { username: "juno", password: pw } });
  const fetch = /** @type {any} */ (fakeBreachFetch([pw]));
  let now = Date.now();

  // Not opted in: no network call, no breached reason.
  const off = await remindTick(vault, planner.call, { clock: () => now, breach: { enabled: false, fetch } });
  assert.deepEqual(off.breached, []);
  assert.equal(db.prepare("SELECT 1 FROM vault_jobs WHERE name = 'breach'").get(), undefined);

  // Opted in: the first tick runs it, and old-forum gets a "breached" todo.
  const on = await remindTick(vault, planner.call, { clock: () => now, breach: { enabled: true, fetch } });
  assert.deepEqual(on.breached, ["old-forum"]);
  assert.equal(on.added.length, 1);
  assert.match([...planner.items.values()][0].title, /old-forum/);
  assert.equal(db.prepare("SELECT at FROM vault_jobs WHERE name = 'breach'").get().at, now);

  // A second tick, minutes later, does not run it again.
  now += 60_000;
  const soon = await remindTick(vault, planner.call, { clock: () => now, breach: { enabled: true, fetch } });
  assert.deepEqual(soon.breached, []);

  // A week on, it runs again.
  now += BREACH_EVERY_MS;
  const week = await remindTick(vault, planner.call, { clock: () => now, breach: { enabled: true, fetch } });
  assert.deepEqual(week.breached, ["old-forum"]);
});

test("reminders: a connection stuck at needs_credential gets a todo, closed once it is ready", async t => {
  const planner = fakePlanner();
  const { run, vault, connections, db } = await recorded(t, { reminders: false }, { call: planner.call });
  const now = Date.now();

  // A module registers before anything grants it the item it names: needs_credential.
  const reg = (await run("vault.connections.register", { ref: "harlow", provider: "imap-smtp", account: "alex@harlowlegal.test",
    auth: "password", capabilities: ["send_mail"], items: ["postbox-harlow"] }, "module:postbox")).id;

  const first = await remindTick(vault, planner.call, { clock: () => now, connections });
  assert.deepEqual(first.added, [`connection:${reg}`]);
  const todo = [...planner.items.values()][0];
  assert.match(todo.title, /^Connect alex@harlowlegal\.test$/);
  assert.equal(todo.priority, 3);

  // A second tick raises nothing new.
  assert.deepEqual((await remindTick(vault, planner.call, { clock: () => now, connections })).added, []);
  assert.equal(planner.items.size, 1);

  // Fixed: the item exists and is granted to postbox. The todo is done.
  await run("vault.put", { name: "postbox-harlow", kind: "login", fields: { username: "alex", password: hex(12) } });
  await run("vault.grant", { name: "postbox-harlow", module: "postbox" });
  await run("vault.connections.sync");
  const closed = await remindTick(vault, planner.call, { clock: () => now, connections });
  assert.deepEqual(closed.closed, [`connection:${reg}`]);
  assert.equal(todo.state, "done");
});

test("reminders: a pass nearing its end gets a heads-up before it lapses", async t => {
  const day = 86400_000;
  const planner = fakePlanner();
  const { run, vault } = await recorded(t, { reminders: false }, { call: planner.call });
  const now = Date.now();
  await run("vault.put", { name: "harlow-api", kind: "api-key", fields: { value: hex(16) } });
  const card = (await vault.card()).card;
  const soon = await vault.createPass({ holder: "Dana", card, items: ["harlow-api"], mode: "sealed", expires: new Date(now + 3 * day).toISOString() }, "cli");
  const far = await vault.createPass({ holder: "Dana", card, items: ["harlow-api"], mode: "sealed", expires: new Date(now + 60 * day).toISOString() }, "cli");

  const first = await remindTick(vault, planner.call, { clock: () => now });
  assert.deepEqual(first.added, [`pass:${soon.pass.id}`], "only the one ending soon");
  const todo = [...planner.items.values()][0];
  assert.match(todo.title, /^Renew or revoke the pass for Dana: it ends \d{4}-\d{2}-\d{2} \(harlow-api\)$/);

  // A second tick raises nothing new.
  assert.deepEqual((await remindTick(vault, planner.call, { clock: () => now })).added, []);

  // Revoked: the heads-up is done.
  await run("vault.pass.revoke", { id: soon.pass.id });
  const revoked = await remindTick(vault, planner.call, { clock: () => now });
  assert.deepEqual(revoked.closed, [`pass:${soon.pass.id}`]);
  assert.equal(todo.state, "done");
  void far;
});
