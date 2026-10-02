// @ts-check
// The CLI as a user runs it: a real process, a real vyred, a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome, upPresent, upLeader } from "./helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");
const run = (args, env) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" } },
    (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr })));
/**
 * How the CLI says a human-only tool was refused with no proof: no controlling terminal (a
 * script, Claude's Bash), or a terminal but no method vyred offers under tests (it shows no
 * Touch ID dialog and writes no terminal code then; core/config/dialogs.js).
 */
const REFUSED = /needs a person at a terminal|needs presence by/;

test("cli: up, status, call, down against a temp home", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  t.after(() => run(["down"], env));
  // A fresh home gets the welcome; an existing one the status line.
  assert.match((await run(["up"], env)).out, /Vyre is installed|is running/);
  assert.match((await run(["up"], env)).out, /already running/);
  assert.match((await run(["status"], env)).out, /modules running/);
  const echo = await run(["call", "system.echo", '{"text":"hi"}'], env);
  assert.equal(echo.code, 0);
  assert.deepEqual(JSON.parse(echo.out), { text: "hi" });
  const bad = await run(["call", "system.echo", "{}"], env);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /bad_input/);
  assert.match((await run(["down"], env)).out, /Vyre stopped/);
  const after = await run(["status"], env);
  assert.equal(after.code, 5, "Vyre not running is exit 5");
  assert.match(after.out, /not running/);
});

test("cli: help lists commands found in the commands folder; unknown commands say so", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  const h = await run(["help"], env);
  for (const c of ["vyre up", "vyre status", "vyre call"]) assert.ok(h.out.includes(c), `help is missing ${c}`);
  const u = await run(["frobnicate"], env);
  assert.equal(u.code, 2, "an unknown command is a usage error");
  assert.match(u.out, /not a command/);
});

test("cli: learn adds, lists, re-levels and retires lessons", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  t.after(() => run(["down"], env));
  assert.match((await run(["learn"], env)).out, /not running/);
  // The real verifier: nothing here proves a person is present. upLeader only trusts the
  // terminal server this test runs under (the testbox's sshd), not any tool's own proof.
  await upLeader(env.VYRE_HOME);
  assert.match((await run(["learn"], env)).out, /no lessons yet/);
  const add = await run(["learn", "add", "never", "use", "em", "dashes"], env);
  assert.equal(add.code, 0);
  assert.match(add.out, /learned lesson 1/);
  const list = await run(["learn"], env);
  assert.match(list.out, /1 lesson/);
  assert.match(list.out, /1 Never use em dashes\. \[block\]/);
  assert.match(list.out, /checks an em dash .* applied 0 · caught 0 · broken 0/);
  assert.match((await run(["learn", "level", "1", "block"], env)).out, /\[block\]/, "raising is free");
  assert.equal((await run(["learn", "level", "1", "loud"], env)).code, 2, "a level that is not one is a usage mistake");
  // Lowering and retiring are the user's own: from their terminal they ask nothing (the no-nag
  // rule). A model's shell is stopped by the Harness floor, and agents by the callers list.
  const lower = await run(["learn", "level", "1", "remind"], env);
  assert.equal(lower.code, 0, lower.out);
  assert.doesNotMatch(lower.out, REFUSED);
  assert.match((await run(["learn"], env)).out, /1 Never use em dashes\. \[remind\]/);
  const retired = await run(["learn", "retire", "1"], env);
  assert.equal(retired.code, 0, retired.out);
  const bad = await run(["learn", "accept", "9"], env);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /no lesson 9/);
});

test("cli: learn show, scope, relax, stats, signals and skills", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  t.after(() => run(["down"], env));
  await upLeader(env.VYRE_HOME);
  await run(["learn", "add", "never", "use", "em", "dashes"], env);
  const list = await run(["learn"], env);
  assert.match(list.out, /1 Never use em dashes\. \[block\] measuring/, "the effect column");
  const show = await run(["learn", "show", "1"], env);
  assert.equal(show.code, 0);
  assert.match(show.out, /everywhere · when always/);
  assert.match(show.out, /before \S+ · after \S+ per 100 turns/);
  assert.equal((await run(["learn", "show", "9"], env)).code, 1);
  // Narrowing is the user's own and asks nothing from their terminal.
  assert.match((await run(["learn", "scope", "1", "agent", "kit"], env)).out, /changed lesson 1/);
  assert.match((await run(["learn", "scope", "1", "all"], env)).out, /changed lesson 1/, "widening is free");
  assert.equal((await run(["learn", "scope", "1", "sideways"], env)).code, 1);
  assert.match((await run(["learn", "relax", "1", "level", "ask"], env)).out, /relaxed lesson 1[\s\S]*\[ask\]/);
  assert.equal((await run(["learn", "relax", "1", "sideways"], env)).code, 1);
  assert.match((await run(["learn", "skills", "install", "3"], env)).out, REFUSED);
  assert.match((await run(["learn", "stats"], env)).out, /before .* per 100 turns/);
  assert.match((await run(["learn", "signals"], env)).out, /nothing heard yet|signals/);
  assert.match((await run(["learn", "skills"], env)).out, /no skills yet/);
  assert.equal((await run(["learn", "skills", "show", "3"], env)).code, 1);
  assert.equal((await run(["learn", "skills", "frob", "3"], env)).code, 2);
  assert.equal((await run(["learn", "frob"], env)).code, 2);
});

test("cli: with a person's proof, relax, scope and retire go through, and say what changed", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  t.after(() => run(["down"], env));
  // vyred with `present`, a verifier that finds a person at every call: this test is about what
  // the commands do once approved. The refusals are the tests above, against the real verifier.
  await upPresent(env.VYRE_HOME);
  await run(["learn", "add", "never", "use", "em", "dashes"], env);
  const scoped = await run(["learn", "scope", "1", "agent", "kit"], env);
  assert.equal(scoped.code, 0, scoped.out);
  assert.match(scoped.out, /changed lesson 1/);
  assert.match((await run(["learn", "show", "1"], env)).out, /agent kit/);
  assert.match((await run(["learn", "relax", "1", "level", "ask"], env)).out, /\[ask\]/);
  assert.match((await run(["learn", "level", "1", "remind"], env)).out, /\[remind\]/);
  assert.match((await run(["learn", "retire", "1"], env)).out, /retired lesson 1/);
  assert.match((await run(["learn"], env)).out, /no lessons yet/);
});

test("cli: vyre threads with nothing to show says so and what to do, never a blank screen", async t => {
  const root = tempHome(t);
  fs.mkdirSync(path.join(root, "tx"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "tx")], vault: { keystore: "file" } }));
  const env = { VYRE_HOME: root };
  t.after(() => run(["down"], env));
  const empty = await run(["threads"], env);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /no Claude Code sessions on this machine yet|indexing your Claude Code sessions now/);
  assert.match((await run(["threads", "croissant"], env)).out, /nothing said matches "croissant"/);
  const help = await run(["threads", "--help"], env);
  assert.equal(help.code, 0);
  assert.match(help.out, /vyre threads \[search\]/);
});
