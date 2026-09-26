// @ts-check
// The CLI as a user runs it: a real process, a real vyred, a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome, upPresent } from "./helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");
const run = (args, env) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" } },
    (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr })));

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
  await upPresent(env.VYRE_HOME);
  assert.match((await run(["learn"], env)).out, /no lessons yet/);
  const add = await run(["learn", "add", "never", "use", "em", "dashes"], env);
  assert.equal(add.code, 0);
  assert.match(add.out, /learned lesson 1/);
  const list = await run(["learn"], env);
  assert.match(list.out, /1 lesson/);
  assert.match(list.out, /1 Never use em dashes\. \[block\]/);
  assert.match(list.out, /checks an em dash .* applied 0 · caught 0 · broken 0/);
  assert.match((await run(["learn", "level", "1", "remind"], env)).out, /\[remind\]/);
  assert.equal((await run(["learn", "level", "1", "loud"], env)).code, 1);
  assert.match((await run(["learn", "retire", "1"], env)).out, /retired lesson 1/);
  assert.match((await run(["learn"], env)).out, /no lessons yet/);
  const bad = await run(["learn", "accept", "9"], env);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /no lesson 9/);
});
