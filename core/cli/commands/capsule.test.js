// @ts-check
// `vyre capsule`: the native app is Lumen. Where it can run, and what the command accepts.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tempHome } from "../../../test/helpers.js";
import capsule, { nativeAvailable, NATIVE } from "./capsule.js";

test("nativeAvailable: a Mac with the native source runs it; vyre up counts it as installed", () => {
  const has = fs.existsSync(path.join(NATIVE, "build.sh"));
  assert.equal(nativeAvailable({ platform: "darwin" }), has);
  assert.equal(nativeAvailable({ platform: "linux" }), false);
  assert.equal(nativeAvailable({ platform: "darwin", dir: "/nonexistent" }), false);
});

test("capsule: the usage names only the native app's commands, every one of them", () => {
  assert.equal(capsule.usage, "vyre capsule [open [--hidden] | install | build] [--json]");
  assert.doesNotMatch(capsule.usage, /electron|--dev|--app/i);
});

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "bin", "vyre");
/** The real bin/vyre in a temp home, dialogs off, as a surface runs it: pipes, no terminal. */
const vyre = (/** @type {string} */ root, /** @type {string[]} */ args) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1", NO_COLOR: "1" }, timeout: 30_000 });

test("capsule: vyre commands lists every verb run() handles; any other word is a usage mistake", t => {
  const root = tempHome(t);
  const d = JSON.parse(vyre(root, ["commands", "capsule", "--json"]).stdout);
  const verbs = d.commands[0].verbs;
  assert.deepEqual(verbs.map(v => [v.verb, v.aliases || []]), [["open", []], ["install", ["build"]]]);
  assert.deepEqual(verbs[0].flags.map(f => f.name), ["hidden", "json"]);
  assert.ok(verbs.every(v => v.read === false), "neither only reads");
  const bad = vyre(root, ["capsule", "biuld", "--json"]);
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error.code, "bad_input");
});

test("capsule --json and --view: a refusal is one error object, never an app launch or a question", t => {
  const root = tempHome(t);
  // Off a Mac: not_mac. On one, dialogs are off here, so it is no_dialogs. Nothing opens either way.
  const want = process.platform === "darwin" ? "no_dialogs" : "not_mac";
  for (const args of [["capsule", "--json"], ["capsule", "open", "--hidden", "--json"]]) {
    const r = vyre(root, args);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.stdout.trim().split("\n").length, 1, r.stdout);
    assert.equal(JSON.parse(r.stdout).error.code, want);
  }
  const v = vyre(root, ["capsule", "--view"]);
  const f = v.stdout.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.code], ["capsule", "error", want]);
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 1 });
  assert.ok(!fs.existsSync(path.join(root, "vyred.pid")), "a refused open starts no vyred");
});

test("capsule install --json: off a Mac, one error object", { skip: process.platform === "darwin" }, t => {
  const r = vyre(tempHome(t), ["capsule", "install", "--json"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).error.code, "not_mac");
});

test("capsule install: builds here and downloads nothing; off a Mac it says Lumen runs on macOS", { skip: process.platform === "darwin" }, t => {
  const root = tempHome(t);
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "bin", "vyre");
  const r = spawnSync(process.execPath, [bin, "capsule", "install"], { encoding: "utf8", env: { ...process.env, VYRE_HOME: root } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Lumen runs on macOS/);
  assert.doesNotMatch(r.stdout + r.stderr, /Vyre-mac\.zip|download/i);
  assert.doesNotMatch(fs.readFileSync(new URL("./capsule.js", import.meta.url), "utf8"), /Vyre-mac\.zip|capsule-install\.js/);
});
