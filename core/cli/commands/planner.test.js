// @ts-check
// `vyre alarm`, `timer`, `remind`, `todo`, `notes`, `agenda` and `snooze` as a person runs them:
// the real bin/vyre in a child process, against a vyred started in this process in a temp home
// with the planner on a fake clock (Thursday 24 Sep 2026, 10:00 in Karachi).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { tempHome } from "../../../test/helpers.js";
import { seams } from "../../planner/index.js";
import { clock, day, dateIn, repeatWords } from "./planner.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");
const KHI = "Asia/Karachi";
const NOW = Date.UTC(2026, 8, 24, 5); // Thursday 10:00 in Karachi

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

async function world(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, planner: { timezone: KHI } }));
  const t0 = { t: NOW };
  seams.set(root, { now: () => t0.t, setTimer: () => ({}), clearTimer: () => {} });
  t.after(() => seams.delete(root));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  return { root, vyre: (/** @type {string[]} */ ...args) => run(root, args), tool: (name, input = {}) => call(name, input, { root }) };
}

test("planner cli: zone formatting and repeat words", () => {
  const at = Date.UTC(2026, 8, 25, 2); // 07:00 Friday in Karachi
  assert.equal(clock(at, KHI), "07:00");
  assert.equal(day(at, KHI), "Fri 25 Sep");
  assert.equal(dateIn(Date.UTC(2026, 8, 24, 20), KHI), "2026-09-25", "01:00 the next day in Karachi");
  assert.equal(repeatWords({ every: "weekday", days: [1, 2, 3, 4, 5] }), "weekdays");
  assert.equal(repeatWords({ every: "week", days: [6, 0] }), "weekends");
  assert.equal(repeatWords({ every: "day" }), "every day");
});

test("planner cli: alarms, timers and reminders in the planner's zone", async t => {
  const { vyre } = await world(t);

  const a = await vyre("alarm", "7am");
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /alarm Fri 25 Sep 07:00/);
  const w = await vyre("alarm", "6:30", "weekdays");
  assert.equal(w.code, 0, w.out);
  assert.match(w.out, /(06|18):30 · weekdays/);

  const list = await vyre("alarm");
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /07:00\s+once\s+next Fri 25 Sep/);
  assert.match(list.out, /weekdays/);
  assert.match(list.out, /Asia\/Karachi/);
  const j = JSON.parse((await vyre("alarm", "--json")).out);
  assert.equal(j.tz, KHI);
  assert.equal(j.alarms.length, 2);
  const once = j.alarms.find(x => !x.repeat);
  const off = await vyre("alarm", "off", once.id);
  assert.equal(off.code, 0, off.out);
  assert.equal(JSON.parse((await vyre("alarm", "--json")).out).alarms.length, 1, "the alarm turned off is not listed");

  const bad = await vyre("alarm", "banana");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /could not read a time in "banana"/);
  assert.match(bad.out, /next: vyre alarm 7am/);

  const tm = await vyre("timer", "10m", "bread");
  assert.equal(tm.code, 0, tm.out);
  assert.match(tm.out, /timer 10m rings at 10:10\s+bread/);
  assert.match((await vyre("timer", "1h30m")).out, /timer 1h 30m rings at 11:30/);
  assert.equal((await vyre("timer")).code, 2);

  const r1 = await vyre("remind", "call juno", "at", "6");
  assert.equal(r1.code, 0, r1.out);
  assert.match(r1.out, /reminder Thu 24 Sep 18:00\s+call juno/);
  const r2 = await vyre("remind", "me", "in", "20", "minutes", "to", "check", "the", "oven");
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /reminder Thu 24 Sep 10:20\s+check the oven/);
  const r3 = await vyre("remind", "me", "tomorrow", "at", "9", "to", "email", "juno");
  assert.match(r3.out, /reminder Fri 25 Sep 09:00\s+email juno/);
  const none = await vyre("remind", "buy", "flour");
  assert.equal(none.code, 1);
  assert.match(none.out, /could not read a time in "buy flour"/);

  const snz = await vyre("snooze", /** @type {string} */ (/(i_\S+)/.exec(r1.out))[1], "15");
  assert.equal(snz.code, 0, snz.out);
  assert.match(snz.out, /snoozed call juno until 10:15/);
});

test("planner cli: todos by list, notes pinned first, and the agenda", async t => {
  const { vyre, tool } = await world(t);

  const t1 = await vyre("todo", "add", "buy", "flour", "!high");
  assert.equal(t1.code, 0, t1.out);
  assert.match(t1.out, /todo buy flour\s+!!!/);
  assert.match((await vyre("todo", "add", "call", "kit", "by", "friday")).out, /call kit\s+due Fri 25 Sep/);
  await vyre("todo", "add", "send", "Harlow", "Legal", "the", "draft");
  assert.ok(!(await tool("planner.add", { kind: "todo", title: "rye flour", list: "Northwind Bakery" })).error);

  const todos = await vyre("todo");
  assert.equal(todos.code, 0, todos.out);
  const lines = todos.out.split("\n");
  const at = s => lines.findIndex(l => l.includes(s));
  assert.ok(at("todo 3") >= 0 && at("Northwind Bakery 1") > at("todo 3"), todos.out);
  assert.ok(at("buy flour") < at("call kit") && at("call kit") < at("send Harlow Legal"), "highest priority, then soonest due");
  assert.ok(at("rye flour") > at("Northwind Bakery 1"));
  const grouped = JSON.parse((await vyre("todo", "--json")).out);
  assert.deepEqual(grouped.lists.map(g => g.list), [null, "Northwind Bakery"]);

  const flour = grouped.lists[0].todos[0];
  const done = await vyre("todo", "done", flour.id);
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /done buy flour/);
  assert.doesNotMatch((await vyre("todo")).out, /buy flour/);
  assert.equal((await vyre("todo", "frob")).code, 2);

  await vyre("notes", "add", "kit", "prefers", "mornings");
  const n2 = await vyre("notes", "add", "the", "printer", "code", "is", "in", "the", "drawer");
  const printer = /** @type {string} */ (/(i_\S+)/.exec(n2.out))[1];
  assert.ok(!(await tool("planner.update", { item: printer, pinned: true, body: "ask alex for the spare key", tags: ["office"] })).error);
  const notes = await vyre("notes");
  assert.equal(notes.code, 0, notes.out);
  assert.ok(notes.out.indexOf("printer code") < notes.out.indexOf("kit prefers"), "pinned first");
  const show = await vyre("notes", "show", printer);
  assert.match(show.out, /pinned the printer code is in the drawer/);
  assert.match(show.out, /ask alex for the spare key/);
  assert.match(show.out, /#office · updated Thu 24 Sep 10:00/);

  await vyre("alarm", "7am");
  await vyre("remind", "call juno", "at", "6");
  await vyre("timer", "10m", "bread");
  const today = await vyre("agenda");
  assert.equal(today.code, 0, today.out);
  assert.match(today.out, /Thu 24 Sep today · Asia\/Karachi/);
  assert.ok(today.out.indexOf("10:10") < today.out.indexOf("18:00"), today.out);
  assert.match(today.out, /18:00\s+reminder\s+call juno/);
  assert.doesNotMatch(today.out, /call kit/, "due tomorrow is not due today");
  const tomorrow = await vyre("agenda", "tomorrow");
  assert.equal(tomorrow.code, 0, tomorrow.out);
  assert.match(tomorrow.out, /Fri 25 Sep tomorrow · Asia\/Karachi/);
  assert.match(tomorrow.out, /07:00\s+alarm\s+Alarm/);
  assert.match(tomorrow.out, /due\n\s+\[ \] call kit/);
  const aj = JSON.parse((await vyre("agenda", "--json")).out);
  assert.equal(aj.tz, KHI);
  assert.equal((await vyre("agenda", "someday")).code, 2);
  t.diagnostic("vyre agenda tomorrow:\n" + tomorrow.out + "\nvyre todo:\n" + (await vyre("todo")).out + "\nvyre agenda:\n" + today.out);
});
