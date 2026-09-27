// @ts-check
// `vyre voice` verbs, --json and --view, in a temp home with no vyred: the real bin/vyre as a
// surface runs it. Nothing here talks, reads a key or opens a terminal: under --view a key is
// asked for as a prompt frame, and push-to-talk is refused because it needs a terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, stdout: string, all: string }>} */
const run = (root, args) => new Promise(resolve => {
  const p = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, stdout, all: stdout + stderr }));
  // stdin stays open: a verb that read it would hang until the timeout, and the test would say so.
  void p;
});
const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

test("voice: vyre commands lists talk, status and key, the verbs run() handles; any other is a usage mistake", async t => {
  const root = tempHome(t);
  const verbs = JSON.parse((await run(root, ["commands", "voice", "--json"])).stdout).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["talk", "status", "key"]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["status"]);
  assert.equal(verbs.find(v => v.verb === "key").person, true);
  assert.deepEqual(verbs.find(v => v.verb === "key").args, [{ name: "choice", required: false, choices: ["deepgram", "openai", "elevenlabs"] }]);
  for (const args of [["voice", "frob"], ["voice", "key", "nope"], ["voice", "--send"], ["voice", "status", "extra"]]) {
    const r = await run(root, [...args, "--json"]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.all}`);
    assert.equal(JSON.parse(r.stdout).error.code, "bad_input", args.join(" "));
  }
});

test("voice status --json: one error object and exit 5 when vyred is not running", async t => {
  const r = await run(tempHome(t), ["voice", "status", "--json"]);
  assert.equal(r.code, 5, r.all);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(r.stdout).error.code, "unreachable");
});

test("voice --view: key is a secret prompt naming the command to pipe it to; push-to-talk needs a terminal", async t => {
  const root = tempHome(t);
  const k = await run(root, ["voice", "key", "openai", "--view"]);
  assert.equal(k.code, 2, k.all);
  const f = frames(k.stdout);
  assert.deepEqual(f[0].view, { kind: "prompt", name: "key", label: "The openai key", secret: true, args: ["voice", "key", "openai", "--stdin"] });
  assert.deepEqual(f[0].data, { prompt: "key", provider: "openai" });
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 2 });

  for (const args of [["voice"], ["voice", "talk"], ["voice", "--send", "t1"]]) {
    const r = await run(root, [...args, "--view"]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.all}`);
    const e = frames(r.stdout)[0].view;
    assert.deepEqual([e.kind, e.code], ["error", "needs_terminal"], args.join(" "));
  }
});
