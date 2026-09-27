// @ts-check
// `vyre sideview` verbs, --json and --view, in a temp home with no vyred: the real bin/vyre as a
// surface runs it. Nothing here opens a window or starts vyred: status is a read and never
// starts it, and a word it does not know is refused first. The side view itself is tested with
// fake tiles in local/sideview.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";
import { card } from "./sideview.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, stdout: string, all: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, stdout, all: stdout + stderr })));

test("sideview: vyre commands lists open, close and status; any other word is a usage mistake naming every verb", async t => {
  const root = tempHome(t);
  const c = JSON.parse((await run(root, ["commands", "sideview", "--json"])).stdout).commands[0];
  assert.deepEqual(c.verbs.map(v => v.verb), ["open", "close", "status"]);
  assert.deepEqual(c.verbs.filter(v => v.read).map(v => v.verb), ["status"]);
  assert.deepEqual(c.verbs[0].flags.map(f => f.name), ["glass", "url", "ratio", "terminal", "json"]);
  assert.match(c.usage, /^vyre sideview \[open\|close\|status\]/);
  const bad = await run(root, ["sideview", "frob", "--json"]);
  assert.equal(bad.code, 2, bad.all);
  const e = JSON.parse(bad.stdout).error;
  assert.equal(e.code, "bad_input");
  assert.match(e.next, /open\|close\|status/);
  assert.ok(!fs.existsSync(path.join(root, "vyred.pid")), "a usage mistake starts nothing");
});

test("sideview status --json and --view: a read that never starts vyred, exit 5 when it is not running", async t => {
  const root = tempHome(t);
  const j = await run(root, ["sideview", "status", "--json"]);
  assert.equal(j.code, 5, j.all);
  assert.equal(j.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(j.stdout).error.code, "unreachable");
  const f = (await run(root, ["sideview", "status", "--view"])).stdout.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.code], ["sideview status", "error", "unreachable"]);
  assert.match(f[0].view.next, /vyre up/);
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 5 });
  assert.ok(!fs.existsSync(path.join(root, "vyred.pid")), "status started no vyred");
});

test("sideview: the open side view is a card with each half and where it sits", () => {
  const d = { open: true, left: { app: "Terminal", frame: { x: 0, y: 25, w: 600, h: 875 } }, right: { app: "Google Chrome", frame: { x: 600, y: 25, w: 840, h: 875 } } };
  assert.deepEqual(card(d), { kind: "card", title: "Side view", state: "open", fields: [
    { label: "Left", value: "Terminal · 600x875 at 0,25" }, { label: "Right", value: "Google Chrome · 840x875 at 600,25" }] });
  assert.deepEqual(card({ open: false }), { kind: "text", lines: ["The side view is not open"] });
});
