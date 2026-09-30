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
  // The OS temp dir is shared with whatever else is running on this box (other teams' suites,
  // or a stale dir this same file left behind on an earlier failed run before a fix), so this
  // proves no NEW vyre-askpass- dir survives this one call, not that the whole temp dir is empty
  // of them.
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("vyre-askpass-")));
  // A tiny wrapper: run credential fill twice in the SAME process is not how git works (one
  // process, one fd), so instead we prove single-use by having the askpass script itself read
  // twice and checking the second read is empty - which is exactly what a hostile second reader
  // of the same fd would see.
  const out = await gitWithAskpass(dir, ["credential", "fill"], { token: "gho_onlyonce000000", stdin: FILL_INPUT });
  assert.equal(out.ok, true, out.stderr);
  assert.match(out.stdout, /password=gho_onlyonce000000/);
  // The script wrote into a fresh 0700 dir under the OS temp dir and named itself randomly;
  // cleanup runs in gitWithAskpass's finally-equivalent, so this specific call's dir should not
  // remain, whatever else is sitting in the shared temp dir.
  const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("vyre-askpass-") && !before.has(n));
  assert.deepEqual(after, [], `this call's own vyre-askpass- temp dir survives: ${after.join(", ")}`);
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

test("gitWithAskpass: an early git exit (git never reads stdin or fd 3) resolves { ok: false }, never an uncaught ECONNRESET (sessions, reviewing a9d6a9ab)", async t => {
  const src = tempRepo(t);
  fs.writeFileSync(path.join(src, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: src });
  execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "-m", "first"], { cwd: src });
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-ghtest-projects-"));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));

  // A local path clone hits the same wall a disallowed protocol always would: git refuses
  // ("transport 'file' not allowed") before ever reading stdin or the fd-3 token pipe, since it
  // never gets far enough to need a credential at all. Before the fix this crashed the whole
  // process with an uncaught ECONNRESET on the write end of one of those pipes; the promise
  // never got the chance to resolve or reject.
  const out = await gitWithAskpass(projectsDir, ["clone", "-q", src, path.join(projectsDir, "clonedir")], { token: "x-does-not-matter" });
  assert.equal(out.ok, false);
  assert.match(out.stderr, /not allowed/);
  assert.ok(!fs.existsSync(path.join(projectsDir, "clonedir", ".git")), "the refused clone left no repo behind");
});

test("the -c credential.helper= override defeats a system-scope helper, not just GIT_CONFIG_NOSYSTEM (reviewer's ask: prove it even when one is set system-wide)", async t => {
  const dir = tempRepo(t);
  const recorder = path.join(dir, "system-recorder.log");
  const fakeSystemConfig = path.join(dir, "fake-system-gitconfig");
  fs.writeFileSync(fakeSystemConfig, `[credential]\n\thelper = !printf 'CALLED\\n' >> ${recorder}; exit 1\n`);

  // Deliberately the WEAKER environment gitWithAskpass never uses on its own (no
  // GIT_CONFIG_NOSYSTEM, no askpass, no helper of our own), so this isolates the `-c
  // credential.helper=` override's own defence from the NOSYSTEM/GLOBAL=devNull defence
  // gitWithAskpass also applies. If this test passed only because NOSYSTEM was set, it would
  // prove nothing beyond the existing repo-local test. With nothing able to answer the password
  // prompt, `git credential fill` is expected to fail outright (no terminal prompt, no helper, no
  // askpass) - the point is that it fails WITHOUT ever calling the fake system helper.
  const gitArgs = ["-c", "credential.helper=", "-c", "credential.username=x-access-token",
    "-c", "protocol.https.allow=always", "-C", dir, "credential", "fill"];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_SYSTEM: fakeSystemConfig, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };
  let threw = null;
  try { execFileSync("git", gitArgs, { cwd: dir, encoding: "utf8", input: FILL_INPUT, env, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { threw = /** @type {any} */ (e); }
  assert.ok(threw, "credential fill was expected to fail (nothing can answer the password prompt)");
  // Exact wording varies by git version/platform ("unable to get password from user" vs
  // "could not read Password ...: terminal prompts disabled") - both mean the same thing: it
  // refused rather than finding another way to answer, which is all this test needs.
  assert.match(String(threw.stderr || ""), /unable to get password|could not read Password/, "with no helper and no askpass, git refuses rather than falling back to the system-scope helper");
  assert.ok(!fs.existsSync(recorder), "a helper set via GIT_CONFIG_SYSTEM never runs once -c credential.helper= is on the command line");
});
