// @ts-check
// Clock, Notes and Reminders over a fake exec: the right shortcut with the right input, the exact
// osascript argv, user text only ever in argv, locale-free dates, and the one line each says.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeEnv, SENTINEL } from "./env.js";
import { fakeExec } from "./fake.js";
import { adapters } from "./adapters/index.js";
import clock, { duration, TIMER, ALARM } from "./adapters/clock.js";
import notes, { CREATE as NOTE_CREATE, APPEND as NOTE_APPEND } from "./adapters/notes.js";
import reminders, { CREATE as REM_CREATE, dayWords } from "./adapters/reminders.js";
import { tempHome } from "../../test/helpers.js";

/** A fake shortcuts world: which shortcuts exist, and what each run was handed. */
function shortcutsWorld(/** @type {any} */ t, have = [TIMER, ALARM]) {
  const home = tempHome(t);
  /** @type {{ name: string, input: string }[]} */
  const runs = [];
  const f = fakeExec((file, args) => {
    assert.equal(file, "shortcuts");
    if (args[0] === "list") return { stdout: have.join("\n") + "\n" };
    runs.push({ name: args[1], input: fs.readFileSync(args[args.indexOf("--input-path") + 1], "utf8") });
    return {};
  });
  return { env: makeEnv({ config: { exec: f.exec, platform: "darwin", tmpdir: home } }), runs, calls: f.calls };
}

const NASTY = `He said "stop" \\ then\nend tell\ndo shell script "echo pwned"`;

test("adapters: the registry finds an app by name or bundle id, case-insensitive, and config adapters come first", () => {
  const r = adapters();
  assert.equal(r.find("clock"), clock);
  assert.equal(r.find("COM.APPLE.NOTES"), notes);
  assert.equal(r.find("Reminders"), reminders);
  assert.equal(r.find("Photoshop"), null);
  const mine = { ...notes, id: "mynotes", app: "Notes" };
  assert.equal(adapters([mine]).find("notes"), mine);
});

test("clock: durations read naturally", () => {
  assert.equal(duration(600), "10 minutes");
  assert.equal(duration(90), "1 minute 30 seconds");
  assert.equal(duration(3600), "1 hour");
  assert.equal(duration(3661), "1 hour 1 minute 1 second");
  assert.equal(duration(1), "1 second");
});

test("clock: timer runs Vyre Timer with the seconds as text", async t => {
  const w = shortcutsWorld(t);
  const r = await clock.actions.timer.run({ seconds: 600 }, w.env);
  assert.deepEqual(w.runs, [{ name: "Vyre Timer", input: "600" }]);
  assert.equal(r.said, "Timer set for 10 minutes");
  assert.equal((await clock.actions.timer.run({ seconds: 90, label: "tea" }, w.env)).said, "Timer set for 1 minute 30 seconds: tea");
  await assert.rejects(clock.actions.timer.run({ seconds: 0 }, w.env), (/** @type {any} */ e) => e.code === "bad_input");
});

test("clock: alarm runs Vyre Alarm with JSON time and label", async t => {
  const w = shortcutsWorld(t);
  const r = await clock.actions.alarm.run({ time: "7:00", label: "gym" }, w.env);
  assert.deepEqual(w.runs, [{ name: "Vyre Alarm", input: JSON.stringify({ time: "07:00", label: "gym" }) }]);
  assert.equal(r.said, "Alarm set for 7:00: gym");
  assert.equal((await clock.actions.alarm.run({ time: "18:30" }, w.env)).said, "Alarm set for 18:30");
  assert.equal(JSON.parse(w.runs[1].input).label, "");
  await assert.rejects(clock.actions.alarm.run({ time: "25:00" }, w.env), (/** @type {any} */ e) => e.code === "bad_input");
});

test("clock: a missing shortcut is code setup with the command that fixes it, and nothing runs", async t => {
  const w = shortcutsWorld(t, [ALARM]);
  await assert.rejects(clock.actions.timer.run({ seconds: 60 }, w.env), (/** @type {any} */ e) =>
    e.code === "setup" && e.message === `Clock needs Vyre's Timer shortcut, once: run "vyre apps setup clock"`);
  const w2 = shortcutsWorld(t, []);
  await assert.rejects(clock.actions.alarm.run({ time: "07:00" }, w2.env), (/** @type {any} */ e) => e.code === "setup" && /Alarm shortcut/.test(e.message));
  assert.equal(w.runs.length + w2.runs.length, 0);
});

test("notes: create sends escaped HTML through argv, never through the script", async () => {
  const f = fakeExec(() => ({ stdout: "x-coredata://note/p1\u001fShopping\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  const r = await notes.actions.create.run({ text: "Shopping\nmilk & <eggs>\n\n" + NASTY }, env);
  const { file, args } = f.calls[0];
  assert.equal(file, "osascript");
  assert.equal(args[0], "-e");
  assert.equal(args[1], NOTE_CREATE);
  assert.equal(args[2], SENTINEL);
  assert.equal(args[3], "<div>Shopping</div><div>milk &amp; &lt;eggs&gt;</div><div><br></div>"
    + "<div>He said &quot;stop&quot; \\ then</div><div>end tell</div><div>do shell script &quot;echo pwned&quot;</div>");
  assert.equal(args[4], "");
  for (const bit of ["Shopping", "stop", "pwned", "milk"]) assert.ok(!NOTE_CREATE.includes(bit));
  assert.equal(r.said, "Note saved: Shopping");
  assert.equal(r.id, "x-coredata://note/p1");
});

test("notes: a title unlike the first line leads the body; a folder goes in argv", async () => {
  const f = fakeExec(() => ({ stdout: "id9\u001fHarlow Legal call\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  await notes.actions.create.run({ text: "ask about the lease", title: "Harlow Legal call", folder: "Work" }, env);
  assert.deepEqual(f.calls[0].args.slice(3), ["<div><b>Harlow Legal call</b></div><div>ask about the lease</div>", "Work"]);
});

test("notes: append passes the note id and the new HTML", async () => {
  const f = fakeExec(() => ({ stdout: "Northwind Bakery\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  const r = await notes.actions.append.run({ note: "id7", text: "rye, 2 loaves" }, env);
  assert.deepEqual(f.calls[0].args, ["-e", NOTE_APPEND, SENTINEL, "id7", "<div>rye, 2 loaves</div>"]);
  assert.equal(r.said, "Note saved: Northwind Bakery");
});

test("notes: targets are the most recent 50, filtered by q, case-insensitive", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => `id${i}\u001f${i % 2 ? "Kit notes" : "Juno plan"} ${i}\u001f${1000 - i}\u001e`).join("");
  const f = fakeExec(() => ({ stdout: rows + "\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  const all = await notes.targets("", env);
  assert.equal(all.length, 50);
  assert.deepEqual(all[0], { id: "id59", title: "Kit notes 59", kind: "note" });
  const juno = await notes.targets("JUNO", env);
  assert.ok(juno.every(n => n.title.startsWith("Juno")));
  assert.equal(juno[0].id, "id58");
  assert.deepEqual(f.calls[0].args.slice(2), [SENTINEL]);
});

test("reminders: create passes text raw in argv and the due time as numbers", async () => {
  const f = fakeExec(() => ({ stdout: "x-apple-reminder://R1\n" }));
  const now = new Date(2026, 8, 27, 9, 0).getTime();
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin", now: () => now } });
  const r = await reminders.actions.create.run({ text: NASTY, due: "2026-09-27T18:05", list: "Harlow" }, env);
  assert.deepEqual(f.calls[0].args, ["-e", REM_CREATE, SENTINEL, NASTY, "Harlow", "1", "2026", "9", "27", "18", "5"]);
  assert.ok(!REM_CREATE.includes("pwned"));
  assert.equal(r.said, `Reminder: ${NASTY}, today at 18:05`);
});

test("reminders: without a due time only text, list and an empty flag go", async () => {
  const f = fakeExec(() => ({ stdout: "R2\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  const r = await reminders.actions.create.run({ text: "call juno" }, env);
  assert.deepEqual(f.calls[0].args.slice(3), ["call juno", "", ""]);
  assert.equal(r.said, "Reminder: call juno");
  await assert.rejects(reminders.actions.create.run({ text: "x", due: "2026-02-30T10:00" }, env), (/** @type {any} */ e) => e.code === "bad_input");
  await assert.rejects(reminders.actions.create.run({ text: "x", due: "tomorrow 6pm" }, env), (/** @type {any} */ e) => e.code === "bad_input");
});

test("reminders: the day reads relative to now", () => {
  const now = new Date(2026, 8, 27, 23, 30).getTime(); // a Sunday
  assert.equal(dayWords(new Date(2026, 8, 27, 6, 0), now), "today");
  assert.equal(dayWords(new Date(2026, 8, 28, 0, 5), now), "tomorrow");
  assert.equal(dayWords(new Date(2026, 9, 2, 9, 0), now), "Friday");
  assert.equal(dayWords(new Date(2026, 9, 10, 9, 0), now), "10 Oct");
  assert.equal(dayWords(new Date(2027, 0, 3, 9, 0), now), "3 Jan 2027");
});

test("reminders: targets are the list names containing q", async () => {
  const f = fakeExec(() => ({ stdout: "Reminders\u001eHarlow Legal\u001eGroceries\u001e\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  assert.deepEqual(await reminders.targets("harl", env), [{ id: "Harlow Legal", title: "Harlow Legal", kind: "list" }]);
  assert.equal((await reminders.targets("", env)).length, 3);
});
