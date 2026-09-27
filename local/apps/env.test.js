// @ts-check
// The environment every adapter reaches the Mac through: osascript takes user text only as argv,
// shortcuts go through temp files, and the real exec refuses before spawning anything when no
// dialog may be shown or the machine is not a Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeEnv, realExec, AppsError, SENTINEL } from "./env.js";
import { tempHome } from "../../test/helpers.js";
import { fakeExec } from "./fake.js";

/** A spy in place of child_process.execFile: nothing is ever spawned. */
function spyExecFile(result = { stdout: "ok\n", stderr: "" }) {
  /** @type {any[]} */
  const calls = [];
  const execFile = (/** @type {any[]} */ ...a) => {
    calls.push(a.slice(0, 3));
    const cb = a[a.length - 1];
    queueMicrotask(() => cb(null, result.stdout, result.stderr));
    return { stdin: { end() {} } };
  };
  return { execFile, calls };
}

test("env: osa passes user text through argv unchanged, and the script string is the constant", async () => {
  const f = fakeExec(() => ({ stdout: "done\n" }));
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  const SCRIPT = "on run argv\nset argv to rest of argv\nreturn item 1 of argv\nend run";
  const nasty = `say "hi" \\ then\nend tell\ndo shell script "rm -rf ~"`;
  const out = await env.osa(SCRIPT, [nasty, "-starts-with-dash"]);
  assert.equal(out, "done");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, "osascript");
  assert.deepEqual(f.calls[0].args, ["-e", SCRIPT, SENTINEL, nasty, "-starts-with-dash"]);
  assert.ok(!f.calls[0].args[1].includes(nasty));
});

test("env: an AppleScript failure carries a code (not_found, setup for Automation, else failed)", async () => {
  const cases = [
    ["execution error: Notes got an error: Can't get folder \"x\". (-1728)", "not_found"],
    ["execution error: Not authorized to send Apple events to Notes. (-1743)", "setup"],
    ["execution error: something else (-2700)", "failed"],
  ];
  for (const [stderr, code] of cases) {
    const env = makeEnv({ config: { exec: fakeExec(() => ({ code: 1, stderr })).exec, platform: "darwin" } });
    await assert.rejects(env.osa("on run argv\nend run", []), (/** @type {any} */ e) => e instanceof AppsError && e.code === code);
  }
});

test("env: shortcuts.list splits lines; run hands input and output through temp files and removes them", async t => {
  const home = tempHome(t);
  /** @type {string[]} */
  let dirs = [];
  const f = fakeExec((file, args) => {
    if (args[0] === "list") return { stdout: "Vyre Timer\nVyre Alarm\n\n" };
    const inPath = args[args.indexOf("--input-path") + 1], outPath = args[args.indexOf("--output-path") + 1];
    dirs.push(inPath);
    assert.equal(fs.readFileSync(inPath, "utf8"), "600");
    fs.writeFileSync(outPath, "started");
    return {};
  });
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin", tmpdir: home } });
  assert.deepEqual(await env.shortcuts.list(), ["Vyre Timer", "Vyre Alarm"]);
  assert.equal(await env.shortcuts.run("Vyre Timer", "600"), "started");
  assert.equal(f.calls[1].file, "shortcuts");
  assert.deepEqual(f.calls[1].args.slice(0, 2), ["run", "Vyre Timer"]);
  assert.ok(dirs[0].startsWith(home));
  assert.equal(fs.existsSync(dirs[0]), false, "the temp input was left behind");
  assert.deepEqual(fs.readdirSync(home), []);
});

test("env: a failing shortcut is code failed with its words", async t => {
  const home = tempHome(t);
  const env = makeEnv({ config: { exec: fakeExec(() => ({ code: 1, stderr: "Error: The operation couldn't be completed." })).exec, platform: "darwin", tmpdir: home } });
  await assert.rejects(env.shortcuts.run("Vyre Timer", "5"), (/** @type {any} */ e) => e.code === "failed" && /couldn't be completed/.test(e.message));
});

test("env: the real exec with dialogs not allowed refuses no_dialog and spawns nothing", async () => {
  const spy = spyExecFile();
  const env = makeEnv({ config: { platform: "darwin" }, execFile: spy.execFile, vars: { NODE_TEST_CONTEXT: "1" } });
  await assert.rejects(env.osa("on run argv\nend run", ["x"]), (/** @type {any} */ e) => e.code === "no_dialog");
  await assert.rejects(env.shortcuts.list(), (/** @type {any} */ e) => e.code === "no_dialog");
  await assert.rejects(env.shortcuts.run("Vyre Timer", "5"), (/** @type {any} */ e) => e.code === "no_dialog");
  await assert.rejects(env.open("Weather"), (/** @type {any} */ e) => e.code === "no_dialog");
  assert.equal(spy.calls.length, 0);
});

test("env: off a Mac, osa and shortcuts refuse not_mac and spawn nothing", async () => {
  const f = fakeExec();
  const env = makeEnv({ config: { exec: f.exec, platform: "linux" } });
  await assert.rejects(env.osa("on run argv\nend run", []), (/** @type {any} */ e) => e.code === "not_mac");
  await assert.rejects(env.shortcuts.list(), (/** @type {any} */ e) => e.code === "not_mac");
  assert.equal(f.calls.length, 0);
});

test("env: with dialogs allowed the real exec path reaches execFile with no shell", async () => {
  const spy = spyExecFile({ stdout: "hello\n", stderr: "" });
  const env = makeEnv({ config: { platform: "darwin" }, execFile: spy.execFile, vars: {} });
  assert.equal(await env.osa("on run argv\nend run", ["a b"]), "hello");
  assert.equal(spy.calls[0][0], "osascript");
  assert.deepEqual(spy.calls[0][1], ["-e", "on run argv\nend run", SENTINEL, "a b"]);
  assert.equal(spy.calls[0][2].shell, undefined);
  assert.equal(spy.calls[0][2].timeout, 15000);
});

test("env: realExec reports a missing binary as setup and a timeout as failed", async () => {
  const missing = realExec((/** @type {any[]} */ ...a) => { const cb = a[a.length - 1]; queueMicrotask(() => cb(Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" }), "", "")); return { stdin: { end() {} } }; });
  await assert.rejects(missing("shortcuts", ["list"]), (/** @type {any} */ e) => e.code === "setup");
  const slow = realExec((/** @type {any[]} */ ...a) => { const cb = a[a.length - 1]; queueMicrotask(() => cb(Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }), "", "")); return { stdin: { end() {} } }; });
  await assert.rejects(slow("osascript", [], { timeoutMs: 2000 }), (/** @type {any} */ e) => e.code === "failed" && /2s/.test(e.message));
  const exit = realExec((/** @type {any[]} */ ...a) => { const cb = a[a.length - 1]; queueMicrotask(() => cb(Object.assign(new Error("exit"), { code: 3 }), "", "bad")); return { stdin: { end() {} } }; });
  assert.deepEqual(await exit("plutil", []), { code: 3, stdout: "", stderr: "bad" });
});

test("env: a script's own vyre:<code> refusal keeps its code and words", async () => {
  const stderr = "execution error: vyre:not_supported: that note is locked, so Vyre cannot add to it (-2700)";
  const env = makeEnv({ config: { exec: fakeExec(() => ({ code: 1, stderr })).exec, platform: "darwin" } });
  await assert.rejects(env.osa("on run argv\nend run", []), (/** @type {any} */ e) =>
    e.code === "not_supported" && e.message === "that note is locked, so Vyre cannot add to it");
});

test("env: an osascript timeout is code setup with the Automation hint; a longer timeout is passed on", async () => {
  const f = fakeExec(() => { throw Object.assign(new AppsError("failed", "osascript did not answer within 15s"), { timedOut: true }); });
  const env = makeEnv({ config: { exec: f.exec, platform: "darwin" } });
  await assert.rejects(env.osa('on run argv\ntell application "Notes"\nend tell\nend run', []), (/** @type {any} */ e) =>
    e.code === "setup" && /Notes/.test(e.message) && /Privacy & Security > Automation/.test(e.message));
  const g = fakeExec();
  await makeEnv({ config: { exec: g.exec, platform: "darwin" } }).osa("on run argv\nend run", [], { timeoutMs: 30000 });
  assert.deepEqual(g.calls[0].opts, { timeoutMs: 30000 });
});
