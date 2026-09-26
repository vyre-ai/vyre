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
import notes, { CREATE as NOTE_CREATE, APPEND as NOTE_APPEND, LIST as NOTE_LIST, TRASH } from "./adapters/notes.js";
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
    e.code === "setup" && e.message === `Clock needs Vyre's Timer shortcut, once: run "vyre apps setup clock" (the apps.setup tool)`);
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

test("notes: create without a folder goes to the default account's default folder", () => {
  assert.match(NOTE_CREATE, /make new note at default folder of default account with properties \{body:theBody\}/);
});

test("notes: append refuses a locked note or one with attachments, as not_supported", async () => {
  assert.match(NOTE_APPEND, /password protected of n/);
  assert.match(NOTE_APPEND, /count of attachments of n/);
  const env = makeEnv({ config: { platform: "darwin", exec: fakeExec(() => ({ code: 1,
    stderr: "execution error: vyre:not_supported: that note has attachments, which adding text would lose (-2700)" })).exec } });
  await assert.rejects(notes.actions.append.run({ note: "id7", text: "more" }, env), (/** @type {any} */ e) =>
    e.code === "not_supported" && /attachments/.test(e.message));
});

test("notes: targets are the most recent 50 outside the trash, filtered by q, case-insensitive", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => `id${i}\u001f${i % 2 ? "Kit notes" : "Juno plan"} ${i}\u001f${1000 - i}\u001e`).join("");
  const f = fakeExec(() => ({ stdout: rows + "id59\u001fKit notes 59\u001f941\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  const all = await notes.targets("", env);
  assert.equal(all.length, 50);
  assert.deepEqual(all[0], { id: "id59", title: "Kit notes 59", kind: "note" });
  assert.equal(all.filter(n => n.id === "id59").length, 1, "a note in two folders listed twice");
  const juno = await notes.targets("JUNO", env);
  assert.ok(juno.every(n => n.title.startsWith("Juno")));
  assert.equal(juno[0].id, "id58");
  assert.deepEqual(f.calls[0].args.slice(2), [SENTINEL, TRASH]);
  assert.deepEqual(f.calls[0].opts, { timeoutMs: 30000 });
  assert.match(NOTE_LIST, /if \(name of f\) is not trashName then/);
  assert.match(NOTE_LIST, /text item delimiters/);
  const g = fakeExec(() => ({ stdout: "" }));
  await notes.targets("", makeEnv({ config: { exec: g.exec, platform: "darwin", notes: { trash: "Zuletzt gelöscht" } } }));
  assert.deepEqual(g.calls[0].args.slice(2), [SENTINEL, "Zuletzt gelöscht"]);
});

// 2026-09-27 09:00 in Kuala Lumpur (UTC+8, no daylight saving), a Sunday.
const KL = "Asia/Kuala_Lumpur";
const NINE_AM = Date.UTC(2026, 8, 27, 1, 0);

test("reminders: create passes text raw in argv and the due time as numbers, time as seconds into the day", async () => {
  const f = fakeExec(() => ({ stdout: "x-apple-reminder://R1\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin", now: () => NINE_AM, timeZone: KL } });
  const r = await reminders.actions.create.run({ text: NASTY, due: "2026-09-27T18:05", list: "Harlow" }, env);
  assert.deepEqual(f.calls[0].args, ["-e", REM_CREATE, SENTINEL, NASTY, "Harlow", "1", "2026", "9", "27", String(18 * 3600 + 5 * 60)]);
  assert.ok(!REM_CREATE.includes("pwned"));
  assert.match(REM_CREATE, /set time of d to \(item 7 of argv\) as integer/);
  assert.match(REM_CREATE, /set theList to list id listRef/);
  assert.equal(r.said, `Reminder: ${NASTY}, today at 18:05`);
});

test("reminders: a due time that has passed, in the configured zone, is refused", async () => {
  const f = fakeExec(() => ({ stdout: "R\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin", now: () => NINE_AM, timeZone: KL } });
  await assert.rejects(reminders.actions.create.run({ text: "x", due: "2026-09-27T08:59" }, env), (/** @type {any} */ e) =>
    e.code === "bad_input" && e.message === "that time has passed");
  await assert.rejects(reminders.actions.create.run({ text: "x", due: "2026-09-27T09:00" }, env), (/** @type {any} */ e) => e.code === "bad_input");
  assert.equal(f.calls.length, 0);
  // The same moment is still 26 Sep in New York, so 27 Sep 00:30 there is tomorrow, not the past.
  const ny = makeEnv({ config: { exec: f.exec, platform: "darwin", now: () => NINE_AM, timeZone: "America/New_York" } });
  assert.equal((await reminders.actions.create.run({ text: "x", due: "2026-09-27T00:30" }, ny)).said, "Reminder: x, tomorrow at 0:30");
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

test("reminders: the day reads relative to now in the given zone", () => {
  assert.equal(dayWords({ y: 2026, mo: 9, d: 27 }, NINE_AM, KL), "today");
  assert.equal(dayWords({ y: 2026, mo: 9, d: 28 }, NINE_AM, KL), "tomorrow");
  assert.equal(dayWords({ y: 2026, mo: 10, d: 2 }, NINE_AM, KL), "Friday");
  assert.equal(dayWords({ y: 2026, mo: 10, d: 10 }, NINE_AM, KL), "10 Oct");
  assert.equal(dayWords({ y: 2027, mo: 1, d: 3 }, NINE_AM, KL), "3 Jan 2027");
  assert.equal(dayWords({ y: 2026, mo: 9, d: 27 }, NINE_AM, "America/New_York"), "tomorrow");
});

test("reminders: targets are lists by id, filtered by name", async () => {
  const f = fakeExec(() => ({ stdout: "L1\u001fReminders\u001eL2\u001fHarlow Legal\u001eL3\u001fGroceries\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  assert.deepEqual(await reminders.targets("harl", env), [{ id: "L2", title: "Harlow Legal", kind: "list" }]);
  assert.equal((await reminders.targets("", env)).length, 3);
});
