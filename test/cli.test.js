// @ts-check
// The CLI as a user runs it: a real process, a real vyred, a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");
const run = (args, env) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" } },
    (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr })));
/**
 * The CLI at a terminal a person holds: `script` gives it a pseudo-terminal, and `typed` is typed
 * once it asks. (That `script` can do this is why confirm.js is a stopgap; ADR 0004 is the proof.)
 */
const runTty = (args, env, typed) => new Promise(resolve => {
  // script(1) will not talk to a socket, which is what Node's pipes are. So a shell pipes a FIFO
  // into it and sends its output to a file, and the answer goes into the FIFO once it is asked.
  const base = path.join(env.VYRE_HOME, `tty-${process.hrtime.bigint()}`);
  execFileSync("mkfifo", [base + ".in"]);
  fs.writeFileSync(base + ".out", "");
  let input = fs.openSync(base + ".in", "r+");
  const done = () => { if (input >= 0) { fs.closeSync(input); input = -1; } };
  const p = spawn("sh", ["-c", 'cat "$1" | script -q /dev/null "$2" "$3" "${@:4}" > "$0" 2>&1', base + ".out", base + ".in", process.execPath, BIN, ...args],
    { env: { ...process.env, ...env, NO_COLOR: "1" }, stdio: "ignore" });
  const read = () => fs.readFileSync(base + ".out", "utf8");
  // The FIFO closes only once the answer was read (more output after it): an early EOF reaches
  // the terminal as ^D ahead of the answer.
  let sent = false;
  const poll = setInterval(() => {
    const o = read();
    if (!sent && /to confirm: /.test(o)) { sent = true; fs.writeSync(input, typed + "\n"); }
    else if (sent && /to confirm: [^\n]*\n[\s\S]*\S/.test(o)) { clearInterval(poll); done(); }
  }, 25);
  const timer = setTimeout(() => { clearInterval(poll); done(); p.kill(); }, 10_000);
  p.on("close", code => { clearInterval(poll); clearTimeout(timer); done(); resolve({ code, out: read().replace(/\r/g, "") }); });
});
const hasScript = process.platform === "darwin" && fs.existsSync("/usr/bin/script");

test("cli: up, status, call, down against a temp home", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  t.after(() => run(["down"], env));
  assert.match((await run(["up"], env)).out, /vyred running/);
  assert.match((await run(["up"], env)).out, /already running/);
  assert.match((await run(["status"], env)).out, /modules running/);
  const echo = await run(["call", "system.echo", '{"text":"hi"}'], env);
  assert.equal(echo.code, 0);
  assert.deepEqual(JSON.parse(echo.out), { text: "hi" });
  const bad = await run(["call", "system.echo", "{}"], env);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /bad_input/);
  assert.match((await run(["down"], env)).out, /vyred stopped/);
  const after = await run(["status"], env);
  assert.equal(after.code, 1);
  assert.match(after.out, /not running/);
});

test("cli: help lists commands found in the commands folder; unknown commands say so", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  const h = await run(["help"], env);
  for (const c of ["vyre up", "vyre status", "vyre call"]) assert.ok(h.out.includes(c), `help is missing ${c}`);
  const u = await run(["frobnicate"], env);
  assert.equal(u.code, 1);
  assert.match(u.out, /not a command/);
});

test("cli: learn adds, lists, re-levels and retires lessons", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  t.after(() => run(["down"], env));
  assert.match((await run(["learn"], env)).out, /not running/);
  await run(["up"], env);
  assert.match((await run(["learn"], env)).out, /no lessons yet/);
  const add = await run(["learn", "add", "never", "use", "em", "dashes"], env);
  assert.equal(add.code, 0);
  assert.match(add.out, /learned lesson 1/);
  const list = await run(["learn"], env);
  assert.match(list.out, /1 lesson/);
  assert.match(list.out, /1 Never use em dashes\. \[block\]/);
  assert.match(list.out, /checks an em dash .* applied 0 · caught 0 · broken 0/);
  assert.match((await run(["learn", "level", "1", "block"], env)).out, /\[block\]/, "raising is free");
  assert.equal((await run(["learn", "level", "1", "loud"], env)).code, 1);
  // Lowering and retiring are the user's: with no terminal (a script, Claude's Bash) they refuse.
  for (const args of [["learn", "level", "1", "remind"], ["learn", "retire", "1"], ["call", "learn.retire", '{"id":1}'], ["call", "learn.relax", '{"id":1,"level":"remind"}']]) {
    const r = await run(args, env);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.out, /needs you at a terminal/, args.join(" "));
  }
  assert.match((await run(["learn"], env)).out, /1 Never use em dashes\. \[block\]/, "nothing changed");
  const bad = await run(["learn", "accept", "9"], env);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /no lesson 9/);
});

test("cli: learn show, scope, relax, stats, signals and skills", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  t.after(() => run(["down"], env));
  await run(["up"], env);
  await run(["learn", "add", "never", "use", "em", "dashes"], env);
  const list = await run(["learn"], env);
  assert.match(list.out, /1 Never use em dashes\. \[block\] measuring/, "the effect column");
  const show = await run(["learn", "show", "1"], env);
  assert.equal(show.code, 0);
  assert.match(show.out, /everywhere · when always/);
  assert.match(show.out, /before \S+ · after \S+ per 100 turns/);
  assert.equal((await run(["learn", "show", "9"], env)).code, 1);
  assert.match((await run(["learn", "scope", "1", "agent", "kit"], env)).out, /needs you at a terminal/);
  assert.match((await run(["learn", "scope", "1", "all"], env)).out, /changed lesson 1/, "widening is free");
  assert.equal((await run(["learn", "scope", "1", "sideways"], env)).code, 1);
  assert.match((await run(["learn", "relax", "1", "paths", "\\.md$"], env)).out, /needs you at a terminal/);
  assert.match((await run(["learn", "relax", "1", "level", "ask"], env)).out, /needs you at a terminal/);
  assert.match((await run(["learn", "show", "1"], env)).out, /everywhere/, "nothing narrowed");
  assert.equal((await run(["learn", "relax", "1", "sideways"], env)).code, 1);
  assert.match((await run(["learn", "skills", "install", "3"], env)).out, /needs you at a terminal/);
  assert.match((await run(["learn", "stats"], env)).out, /before .* per 100 turns/);
  assert.match((await run(["learn", "signals"], env)).out, /nothing heard yet|signals/);
  assert.match((await run(["learn", "skills"], env)).out, /no skills yet/);
  assert.equal((await run(["learn", "skills", "show", "3"], env)).code, 1);
  assert.equal((await run(["learn", "skills", "frob", "3"], env)).code, 1);
  assert.equal((await run(["learn", "frob"], env)).code, 1);
});

test("cli: at a terminal, the person reads the lesson and types its id back to relax or retire it", { skip: !hasScript && "needs macOS script(1)" }, async t => {
  const env = { VYRE_HOME: tempHome(t) };
  t.after(() => run(["down"], env));
  await run(["up"], env);
  await run(["learn", "add", "never", "use", "em", "dashes"], env);
  const wrong = await runTty(["learn", "relax", "1", "level", "ask"], env, "2");
  assert.match(wrong.out, /Relax lesson 1: "Never use em dashes\." \[block\]/);
  assert.match(wrong.out, /not confirmed/);
  assert.match((await run(["learn", "show", "1"], env)).out, /\[block\]/);
  const scoped = await runTty(["learn", "scope", "1", "agent", "kit"], env, "1");
  assert.match(scoped.out, /changed lesson 1/);
  assert.match((await run(["learn", "show", "1"], env)).out, /agent kit/);
  assert.match((await runTty(["learn", "relax", "1", "level", "ask"], env, "1")).out, /\[ask\]/);
  assert.match((await runTty(["learn", "retire", "1"], env, "1")).out, /retired lesson 1/);
  assert.match((await run(["learn"], env)).out, /no lessons yet/);
});
