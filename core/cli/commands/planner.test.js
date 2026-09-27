// @ts-check
// `vyre alarm`, `timer`, `remind`, `todo`, `notes`, `agenda`, `snooze`, `ringing` and `dismiss` as a person runs them:
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
  // The planner's timers are kept, not run: `advance` moves the clock and runs what fell due.
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  let seq = 0;
  seams.set(root, { now: () => t0.t, setTimer: (fn, ms) => { timers.set(++seq, { at: t0.t + ms, fn }); return seq; }, clearTimer: id => { timers.delete(id); } });
  t.after(() => seams.delete(root));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const advance = ms => {
    const end = t0.t + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      t0.t = next[1].at;
      next[1].fn();
    }
    t0.t = end;
  };
  return { root, advance, vyre: (/** @type {string[]} */ ...args) => run(root, args), tool: (name, input = {}) => call(name, input, { root }) };
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

const idIn = out => /** @type {string} */ ((/(i_\S+)/.exec(out) || [])[1]);

test("planner cli: edit and rm for todos, notes, alarms, timers and reminders, and the wrong kind refused", async t => {
  const { vyre, tool } = await world(t);

  const td = idIn((await vyre("todo", "add", "buy", "flour")).out);
  const e1 = await vyre("todo", "edit", td, "buy", "rye", "flour", "!high", "by", "friday");
  assert.equal(e1.code, 0, e1.out);
  assert.match(e1.out, /todo buy rye flour\s+!!!\s+due Fri 25 Sep/);
  const ej = JSON.parse((await vyre("todo", "edit", td, "buy", "spelt", "--json")).out);
  assert.equal(ej.title, "buy spelt");
  assert.equal(ej.priority, 3, "words without a priority keep it");
  assert.equal((await vyre("todo", "edit", td)).code, 2, "edit needs the new words");

  const nt = idIn((await vyre("notes", "add", "kit", "prefers", "mornings")).out);
  const ne = await vyre("notes", "edit", nt, "kit", "prefers", "afternoons");
  assert.equal(ne.code, 0, ne.out);
  assert.match(ne.out, /note kit prefers afternoons/);

  const al = idIn((await vyre("alarm", "7am")).out);
  const ae = await vyre("alarm", "edit", al, "8am");
  assert.equal(ae.code, 0, ae.out);
  assert.match(ae.out, /alarm Fri 25 Sep 08:00/);
  const wk = idIn((await vyre("alarm", "6:30", "weekdays")).out);
  const we = await vyre("alarm", "edit", wk, "7:15");
  assert.equal(we.code, 0, we.out);
  assert.match(we.out, /07:15 · weekdays/, "a repeating alarm keeps its days");
  assert.match((await vyre("alarm", "edit", al, "banana")).out, /could not read a time in "banana"/);

  const tm = idIn((await vyre("timer", "10m", "bread")).out);
  const te = await vyre("timer", "edit", tm, "25m");
  assert.equal(te.code, 0, te.out);
  assert.match(te.out, /timer 25m rings at 10:25\s+bread/);
  const tl = JSON.parse((await vyre("timer", "list", "--json")).out);
  assert.deepEqual(tl.timers.map(x => x.id), [tm]);
  assert.match((await vyre("timer", "list")).out, /timer Thu 24 Sep 10:25\s+bread/);

  const rm = idIn((await vyre("remind", "call juno", "at", "6")).out);
  const re1 = await vyre("remind", "edit", rm, "call juno", "at", "7");
  assert.equal(re1.code, 0, re1.out);
  assert.match(re1.out, /reminder Thu 24 Sep 19:00\s+call juno/);
  const re2 = await vyre("remind", "edit", rm, "call", "juno", "about", "Harlow", "Legal");
  assert.match(re2.out, /reminder Thu 24 Sep 19:00\s+call juno about Harlow Legal/, "words without a time keep the time");
  const rl = await vyre("remind", "list");
  assert.equal(rl.code, 0, rl.out);
  assert.match(rl.out, /19:00\s+call juno about Harlow Legal/);

  // An id of another kind is refused, naming the command that owns it; nothing is deleted.
  const wrong = await vyre("alarm", "rm", td);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /is a todo, not an alarm/);
  assert.match(wrong.out, /next: vyre todo rm i_/);
  const wj = JSON.parse((await vyre("notes", "rm", al, "--json")).out);
  assert.equal(wj.error.code, "bad_input");
  assert.equal((await tool("planner.get", { item: td })).data.item.title, "buy spelt");

  for (const [cmd, id] of [["todo", td], ["notes", nt], ["alarm", al], ["timer", tm], ["remind", rm]]) {
    const r = await vyre(cmd, "rm", id);
    assert.equal(r.code, 0, `${cmd} rm: ${r.out}`);
    assert.match(r.out, /deleted /);
  }
  const gone = await tool("planner.get", { item: td });
  assert.ok(gone.error || gone.data.item.deleted_at, "the todo is deleted");
  assert.doesNotMatch((await vyre("todo")).out, /spelt/);
  assert.doesNotMatch((await vyre("notes")).out, /afternoons/);
  assert.equal(JSON.parse((await vyre("alarm", "--json")).out).alarms.length, 1, "only the weekday alarm is left");
  const again = await vyre("todo", "rm", "i_nope");
  assert.equal(again.code, 1);
  assert.match(again.out, /no such item/);
  assert.equal((await vyre("todo", "rm")).code, 2);
});

test("planner cli: ringing lists what rings, and dismiss stops it", async t => {
  const { vyre, advance } = await world(t);
  assert.match((await vyre("ringing")).out, /nothing is ringing/);
  assert.deepEqual(JSON.parse((await vyre("ringing", "--json")).out), []);
  const tm = idIn((await vyre("timer", "1m", "bread")).out);
  const al = idIn((await vyre("alarm", "10:05")).out);
  advance(6 * 60_000);

  const r = await vyre("ringing");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /timer 10:01 bread\s+rung 2 times\s+f_/, "a timer unanswered for 5 minutes rings again");
  assert.match(r.out, /alarm 10:05 Alarm\s+f_/);
  assert.match(r.out, /vyre dismiss <id> stops one/);
  const rows = JSON.parse((await vyre("ringing", "--json")).out);
  assert.deepEqual(rows.map(x => x.item).sort(), [tm, al].sort());

  // By firing id, and by the item's id.
  const byFiring = await vyre("dismiss", rows.find(x => x.item === tm).firing);
  assert.equal(byFiring.code, 0, byFiring.out);
  assert.match(byFiring.out, /dismissed bread/);
  const dj = JSON.parse((await vyre("dismiss", al, "--json")).out);
  assert.equal(dj.firing.state, "acked");
  assert.equal(dj.item.state, "done", "a one-off alarm ends");
  assert.deepEqual(JSON.parse((await vyre("ringing", "--json")).out), []);

  const twice = await vyre("dismiss", rows[0].firing);
  assert.equal(twice.code, 0, twice.out);
  assert.match(twice.out, /already/);
  assert.equal((await vyre("dismiss")).code, 2);
  const none = await vyre("dismiss", "i_nope");
  assert.equal(none.code, 1);
  assert.match(none.out, /next: vyre ringing lists what rings/);
  assert.match((await vyre("help")).out, /vyre ringing[\s\S]*vyre dismiss/);
});

test("planner cli: timer rm and remind rm delete their own kind, answer --json, and refuse a missing or wrong id", async t => {
  const { vyre, tool } = await world(t);
  const tm = idIn((await vyre("timer", "10m", "bread")).out);
  const rm = idIn((await vyre("remind", "call juno", "at", "6")).out);
  const other = idIn((await vyre("timer", "25m", "rye")).out);

  // No id: a usage mistake, with the command that shows one.
  const bare = await vyre("timer", "rm");
  assert.equal(bare.code, 2, bare.out);
  assert.match(bare.out, /vyre timer rm needs a timer's id/);
  assert.match(bare.out, /next: vyre timer rm i_\.\.\./);
  const bareR = await vyre("remind", "rm");
  assert.equal(bareR.code, 2, bareR.out);
  assert.match(bareR.out, /next: vyre remind rm i_\.\.\./);

  // A reminder's id given to timer rm is refused, and the reminder stays.
  const wrong = await vyre("timer", "rm", rm);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /is a reminder, not a timer/);
  assert.match(wrong.out, new RegExp(`next: vyre remind rm ${rm}`));
  assert.equal((await tool("planner.get", { item: rm })).data.item.kind, "reminder");

  const gone = await vyre("timer", "rm", tm);
  assert.equal(gone.code, 0, gone.out);
  assert.match(gone.out, new RegExp(`deleted bread\\s+${tm}`));
  assert.deepEqual(JSON.parse((await vyre("timer", "list", "--json")).out).timers.map(x => x.id), [other], "only the other timer is left");

  const rj = await vyre("remind", "delete", rm, "--json");
  assert.equal(rj.code, 0, rj.out);
  const d = JSON.parse(rj.out);
  assert.equal(d.removed, rm);
  assert.ok(d.restore_until > NOW, "it can be restored for a while");
  assert.match((await vyre("remind", "list")).out, /no reminders set/);
  // A second rm is harmless: the reminder stays deleted, and nothing else is.
  const again = await vyre("remind", "rm", rm, "--json");
  assert.equal(again.code, 0, again.out);
  assert.ok(JSON.parse(again.out).deleted_at);
  assert.deepEqual(JSON.parse((await vyre("timer", "list", "--json")).out).timers.map(x => x.id), [other]);
});
