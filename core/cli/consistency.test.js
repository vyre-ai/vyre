// @ts-check
// Every `vyre` command behaves the same way (core/cli/kit.js): help for each, --json on every
// read, exit 2 with a next step for a usage mistake, exit 5 with a next step when vyred is not
// running, and never a stack trace. Real processes, a real vyred, temp homes.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome, upPresent } from "../../test/helpers.js";
import { commands } from "./index.js";
import { parse, closest, exitFor, UsageError, EXIT } from "./kit.js";
import { colorOn } from "./style.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vyre");
/** Everything any run printed, checked for stack frames at the end. */
const seen = [];
/** @returns {Promise<{ code: number, out: string, err: string }>} */
const vyre = (args, env, cwd) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: "1", ...env }, cwd, timeout: 60_000 },
    (err, stdout, stderr) => {
      const r = { code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout, err: stderr };
      seen.push({ args, debug: Boolean(env && env.VYRE_DEBUG), text: stdout + stderr });
      resolve(r);
    }));
const STACK = /\n\s+at \S/;

test("kit: parse knows --json and --help, refuses unknown flags when told the known ones", () => {
  assert.deepEqual(parse(["a", "--json", "--project", "x", "b"], { values: ["project"] }), { flags: { json: true, project: "x" }, pos: ["a", "b"] });
  assert.deepEqual(parse(["--name=Harlow Legal"], { values: ["name"] }).flags, { name: "Harlow Legal" });
  assert.throws(() => parse(["--bogus", "1"], { values: ["project"], cmd: "threads" }), (e) => e instanceof UsageError && /--bogus is not a flag of vyre threads/.test(e.message) && e.next === "vyre help threads");
  assert.throws(() => parse(["--project"], { values: ["project"] }), /--project needs a value/);
  // A valued flag never swallows the next flag.
  assert.throws(() => parse(["--project", "--json"], { values: ["project"] }), /needs a value/);
  // Without a known list, any flag takes a value, as the old parser did.
  assert.deepEqual(parse(["--whatever", "1"]).flags, { whatever: "1" });
});

test("kit: exit codes and did-you-mean", () => {
  assert.equal(exitFor({ code: "unreachable" }), EXIT.UNREACHABLE);
  assert.equal(exitFor({ code: "presence_required" }), EXIT.PRESENCE);
  assert.equal(exitFor({ code: "locked" }), EXIT.LOCKED);
  assert.equal(exitFor({ code: "bad_input" }), EXIT.FAILED);
  assert.deepEqual(closest("thraeds", ["threads", "recall", "resume"]), ["threads"]);
  assert.deepEqual(closest("stat", ["status", "start", "up"]), ["status", "start"], "a prefix beats one edit");
  assert.deepEqual(closest("zzzzzz", ["threads", "up"]), []);
});

test("style: NO_COLOR beats FORCE_COLOR, FORCE_COLOR colours a pipe, TERM=dumb is plain", () => {
  assert.equal(colorOn({ isTTY: true }, {}), true);
  assert.equal(colorOn({ isTTY: false }, {}), false);
  assert.equal(colorOn({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(colorOn({ isTTY: true }, { FORCE_COLOR: "0" }), false);
  assert.equal(colorOn({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "1" }), false);
  assert.equal(colorOn({ isTTY: true }, { TERM: "dumb" }), false);
});

test("every command has a summary and a usage, and vyre help <cmd> and <cmd> --help work", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  const all = await commands();
  for (const c of all) {
    assert.ok(c.summary, `${c.name} has no summary`);
    if (!c.hidden) assert.ok(c.usage, `${c.name} has no usage`);
  }
  const names = [...new Set(all.filter(c => !c.hidden).map(c => c.name))];
  for (const n of names) {
    const h = await vyre(["help", n], env);
    assert.equal(h.code, 0, `vyre help ${n}: ${h.out}`);
    assert.match(h.out, new RegExp(`vyre ${n}`), `vyre help ${n} does not show its usage`);
    const h2 = await vyre([n, "--help"], env);
    assert.equal(h2.code, 0, `vyre ${n} --help: ${h2.out}`);
  }
  // None of that started a daemon: help is not a command's run.
  assert.ok(!fs.existsSync(path.join(env.VYRE_HOME, "vyred.pid")), "a --help started vyred");
  const top = await vyre(["help"], env);
  for (const n of names) assert.ok(top.out.includes(`vyre ${n}`), `vyre help leaves out ${n}`);
  assert.match(top.out, /exit codes: 0 ok · 1 failed · 2 usage/);
});

test("usage mistakes exit 2 and say what to do next", async t => {
  const home = tempHome(t);
  const env = { VYRE_HOME: home };
  assert.equal((await upPresent(home)).code, 0);
  t.after(() => vyre(["down"], env));
  const cases = [
    ["frobnicate"], ["thraeds"], ["threads", "list", "--bogus", "1"], ["threads", "send"], ["threads", "answer", "abcd", "maybe"],
    ["threads", "watch"], ["open"], ["resume"], ["resume", "--wat", "x"], ["learn", "level", "x"], ["learn", "frob"], ["agents", "frob"],
    ["agents", "create"], ["watchers", "pause"], ["watchers", "frob"], ["name", "check"], ["presence", "frob"], ["link", "frob"],
    ["memory", "correct"], ["why"], ["call"], ["capsule", "biuld"], ["box", "frob"], ["pick", "harlow-legal"], ["projects", "--bogus", "x"],
    ["timer"], ["remind"], ["todo", "frob"], ["notes", "show"], ["alarm", "off"], ["agenda", "someday"], ["snooze"],
  ];
  for (const args of cases) {
    const r = await vyre(args, env);
    assert.equal(r.code, 2, `vyre ${args.join(" ")} exited ${r.code}: ${r.out}${r.err}`);
    assert.match(r.out, /next: /, `vyre ${args.join(" ")} gave no next step: ${r.out}`);
  }
  assert.match((await vyre(["thraeds"], env)).out, /did you mean vyre threads/);
  const j = await vyre(["threads", "send", "--json"], env);
  assert.equal(j.code, 2);
  const e = JSON.parse(j.out).error;
  assert.equal(e.code, "bad_input");
  assert.ok(e.next, "a JSON usage error names the next step too");
});

test("every read takes --json and prints JSON", async t => {
  const home = tempHome(t);
  const env = { VYRE_HOME: home };
  assert.equal((await upPresent(home)).code, 0);
  t.after(() => vyre(["down"], env));
  const reads = [
    ["status"], ["modules"], ["tools"], ["projects"], ["threads"], ["threads", "--all"], ["threads", "list"], ["threads", "asks"],
    ["agents"], ["agents", "list"], ["agents", "usage"], ["memory"], ["memory", "corrections"], ["learn"], ["watchers"], ["watchers", "items"],
    ["link"], ["recall"], ["recall", "anything"], ["presence", "keys"], ["box"], ["vault", "list"], ["index"],
    ["agenda"], ["agenda", "tomorrow"], ["alarm"], ["todo"], ["notes"],
  ];
  for (const args of reads) {
    const r = await vyre([...args, "--json"], env, home);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.out); }, `vyre ${args.join(" ")} --json printed: ${r.out.slice(0, 300)}`);
    assert.equal(r.out.trim().split("\n").length, 1, `vyre ${args.join(" ")} --json printed more than one line`);
    assert.ok(!(parsed && parsed.error), `vyre ${args.join(" ")} --json failed: ${r.out}`);
    assert.equal(r.code, 0, `vyre ${args.join(" ")} --json exited ${r.code}`);
  }
  // context from a folder in no project: JSON still, and exit 1.
  const ctx = await vyre(["context", "--json"], env, home);
  assert.equal(JSON.parse(ctx.out).project, null);
  assert.equal(ctx.code, 1);
});

test("vyred not running: exit 5, and the next step is vyre up", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  for (const args of [["status"], ["modules"], ["tools"], ["learn"], ["watchers"], ["link"], ["memory"], ["name"]]) {
    const r = await vyre(args, env);
    assert.equal(r.code, 5, `vyre ${args.join(" ")} exited ${r.code}: ${r.out}`);
    assert.match(r.out, /not running/);
    assert.match(r.out, /vyre up/);
  }
  const j = await vyre(["status", "--json"], env);
  assert.equal(j.code, 5);
  const e = JSON.parse(j.out).error;
  assert.equal(e.code, "unreachable");
  assert.match(e.next, /vyre up/);
});

test("a command that throws prints one line and a hint, never a stack trace", async t => {
  const dir = tempHome(t);
  // A home that is a file: making its folders throws inside the command.
  const file = path.join(dir, "not-a-folder");
  fs.writeFileSync(file, "");
  const r = await vyre(["projects"], { VYRE_HOME: file });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /vyre projects stopped: /);
  assert.match(r.out, /VYRE_DEBUG=1 shows the trace/);
  assert.doesNotMatch(r.out + r.err, STACK);
  const d = await vyre(["projects"], { VYRE_HOME: file, VYRE_DEBUG: "1" });
  assert.match(d.err, STACK, "VYRE_DEBUG=1 shows the trace");
});

test("no output above carried a stack trace", () => {
  // Only the run that asked for one with VYRE_DEBUG=1 may show it.
  const leaks = seen.filter(s => !s.debug && STACK.test(s.text));
  assert.deepEqual(leaks.map(s => "vyre " + s.args.join(" ")), []);
});
