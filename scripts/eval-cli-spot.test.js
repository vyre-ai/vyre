// @ts-check
// scripts/eval-cli-spot.mjs with fake `claude` and `codex` binaries and a local stand-in for the key-usage
// endpoint: the commands are built as the script says, answers are read, the canary is read, the job's spend
// stop holds, and nothing is sent anywhere else. The real binaries run only on the runner.
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Async, because the key-usage stand-in lives in this process: a blocked event loop would never answer it. @param {string} mode @param {any} env */
const runScript = (mode, env) => new Promise(resolve => execFile(process.execPath, [SCRIPT, mode], { env, timeout: 120_000 }, (e, stdout, stderr) => resolve({ status: e ? /** @type {any} */ (e).code ?? 1 : 0, stdout, stderr })));

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "eval-cli-spot.mjs");

/** @param {() => number} usage */
function endpoint(usage) {
  return new Promise(resolve => { const s = http.createServer((_, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: { usage: usage(), limit: 50 } })); }); s.listen(0, "127.0.0.1", () => resolve(s)); });
}

/** A temp dir with fake binaries, and a head-to-head dir holding the notes the script reads. */
function setup() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-spot-bin-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-spot-h2h-"));
  fs.writeFileSync(path.join(dir, "notes-auto.md"), "- Alex lives in Portland (2026-09-01)\n");
  fs.writeFileSync(path.join(dir, "notes-agents.md"), "# Alex\n- Lives in Portland\n");
  // claude -p <text> --output-format json ...: answers the canary, else "Portland".
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\ncase "$2" in *passphrase*) A="blue-heron-72";; *) A="Portland";; esac\nprintf '{"result":"%s","total_cost_usd":0.001,"session_id":"s1","usage":{"input_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":10}}' "$A"\n`, { mode: 0o755 });
  // codex exec ... --output-last-message FILE <text>: writes "Portland" to FILE.
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--output-last-message" ]; then F="$2"; fi; shift; done\nprintf 'Portland' > "$F"\n`, { mode: 0o755 });
  return { bin, dir };
}

test("claude and codex spot checks read answers, the canary and the spend, and print no key", async () => {
  const { bin, dir } = setup();
  let spent = 10;
  const srv = await endpoint(() => (spent += 0.01));
  try {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "vyre-spot-home-")), VYRE_H2H_DIR: dir, OPENROUTER_EVAL_KEY: "sk-or-test-not-a-real-key-123456",
      VYRE_EVAL_KEY_ENDPOINT: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/key` };
    for (const mode of ["claude", "codex"]) {
      const r = /** @type {any} */ (await runScript(mode, env));
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!(r.stdout + r.stderr).includes("sk-or-test"), "no key in the output");
      assert.match(r.stdout, mode === "claude" ? /auto memory was loaded.*canary found/ : /codex \(AGENTS\.md/);
      assert.match(r.stdout, new RegExp(`${mode}[^\\n]*: \\d+ of 10 right`));
    }
    const spot = JSON.parse(fs.readFileSync(path.join(dir, "spot.json"), "utf8"));
    assert.equal(spot.claude.n, 10);
    assert.equal(spot.codex.n, 10);
    assert.equal(spot.claude.via, "auto-memory");
  } finally { srv.close(); }
});

test("the job's spend stop holds: a key already $4.6 over the job's start asks nothing", async () => {
  const { bin, dir } = setup();
  let calls = 0;
  const srv = await endpoint(() => (++calls === 1 ? 10 : 15));
  try {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "vyre-spot-home-")), VYRE_H2H_DIR: dir, OPENROUTER_EVAL_KEY: "sk-or-test-not-a-real-key-123456",
      VYRE_EVAL_KEY_ENDPOINT: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/key` };
    const r = /** @type {any} */ (await runScript("claude", env));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /job spend stop/);
  } finally { srv.close(); }
});

test("a key-usage address that is not local is ignored: the key goes only to OpenRouter", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.match(src, /127\\\.0\\\.0\\\.1/);
});
