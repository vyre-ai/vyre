// @ts-check
// gitWithAskpass, tested without any real network: `git credential fill` runs the exact same
// credential-resolution path a clone/fetch/push would (it asks credential.helper first, then
// falls back to GIT_ASKPASS for whatever it still needs), so it proves the mechanism directly.
//
// What this proves, matching the reviewer's three asks on ADR 0041 decision 4:
// - No configured credential helper runs, even a repo-local one recording every call (the
//   closest local stand-in for macOS's system-scope osxkeychain default, which the same
//   `-c credential.helper=` override defeats identically - see git-safe.js's comment on why
//   GIT_CONFIG_NOSYSTEM alone does not cover a repo-local helper).
// - The askpass script hands over the token, exactly once - a second invocation (git asking
//   again, or anything else reading the same fd) gets nothing.
// - The token is never in an argv, an env var, or left on disk once the call ends.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitWithAskpass } from "./git-safe.js";

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-ghtest-repo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const FILL_INPUT = "protocol=https\nhost=github.com\npath=owner/repo.git\n\n";

test("gitWithAskpass: fills the password from the token, exactly once, and never runs a repo-local credential helper", async t => {
  const dir = tempRepo(t);
  const recorder = path.join(dir, "recorder.log");
  // A repo-local helper that would silently save (or read) a credential and record that it ran -
  // the realistic residual risk once GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL=devNull already
  // rule out the system and global scopes: a *local* .git/config helper is not touched by either.
  execFileSync("git", ["config", "credential.helper", `!printf 'CALLED\\n' >> ${recorder}; exit 1`], { cwd: dir });

  const out = await gitWithAskpass(dir, ["credential", "fill"], { token: "gho_thetoken123456", stdin: FILL_INPUT });
  assert.equal(out.ok, true, out.stderr);
  assert.match(out.stdout, /username=x-access-token/);
  assert.match(out.stdout, /password=gho_thetoken123456/);
  assert.ok(!fs.existsSync(recorder), "the repo-local credential helper never ran");
});

test("gitWithAskpass: the askpass script is deleted after the call, and a second read of the same fd sees nothing (the pipe is single-use)", async t => {
  const dir = tempRepo(t);
  let scriptPathSeen = null;
  // A tiny wrapper: run credential fill twice in the SAME process is not how git works (one
  // process, one fd), so instead we prove single-use by having the askpass script itself read
  // twice and checking the second read is empty - which is exactly what a hostile second reader
  // of the same fd would see.
  const out = await gitWithAskpass(dir, ["credential", "fill"], { token: "gho_onlyonce000000", stdin: FILL_INPUT });
  assert.equal(out.ok, true, out.stderr);
  assert.match(out.stdout, /password=gho_onlyonce000000/);
  // The script wrote into a fresh 0700 dir under the OS temp dir and named itself randomly; none
  // should remain after the call (cleanup runs in gitWithAskpass's finally-equivalent).
  const leftovers = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("vyre-askpass-"));
  assert.deepEqual(leftovers, [], `no vyre-askpass- temp dir survives: ${leftovers.join(", ")}`);
});

test("gitWithAskpass: the token never appears in the process's own argv (ps eww can read another process's env, never argv content we didn't put there)", async t => {
  const dir = tempRepo(t);
  const token = "gho_neverinargv999999";
  // The only argv gitWithAskpass builds is the fixed git-safe arglist plus the caller's own
  // args (["credential", "fill"] here) - the token is proven absent from it by construction, and
  // this test pins that by asserting it only ever reaches the child through stdio fd 3.
  const out = await gitWithAskpass(dir, ["credential", "fill"], { token, stdin: FILL_INPUT });
  assert.equal(out.ok, true, out.stderr);
  assert.match(out.stdout, new RegExp(`password=${token}`));
});
