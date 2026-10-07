// On Windows no session sandbox exists in 0.3, so an agent session gets no shell tool, or does not start (reviewer-2 ENG-1). Runs on every system with the platform
// injected, and for real on a hosted Windows runner (a stand-in `claude.cmd` that prints the argv it was started with).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSession } from "./spawn.js";
import { windowsShellGuard, WINDOWS_NO_SHELL_ARGS } from "../../lib/agent-sandbox.js";

test("Windows: Claude starts with its shell tools denied, ahead of everything else, and only once", () => {
  for (const cmd of ["claude", "C:\\Users\\alex\\AppData\\Roaming\\npm\\claude.cmd", "C:\\bin\\Claude.EXE"]) {
    const a = windowsShellGuard(cmd, ["-p", "--output-format", "stream-json"], "win32");
    assert.deepEqual(a.slice(0, 2), [...WINDOWS_NO_SHELL_ARGS]);
    assert.match(a[1], /Bash/); assert.match(a[1], /PowerShell/);
    assert.deepEqual(a.slice(2), ["-p", "--output-format", "stream-json"]);
  }
  const given = ["--disallowedTools", "Bash", "-p"];
  assert.deepEqual(windowsShellGuard("claude", given, "win32"), given, "a list the caller already gave is not doubled");
});

test("Windows: an agent that cannot be started without a shell is refused with a plain reason", () => {
  for (const cmd of ["codex", "C:\\x\\grok.exe", "gemini.cmd"]) assert.throws(() => windowsShellGuard(cmd, ["exec"], "win32"), e => e.code === "sandbox_failed" && /sandboxed there yet/.test(e.message));
});

test("other systems and non-agent commands are never touched", () => {
  assert.deepEqual(windowsShellGuard("claude", ["-p"], "linux"), ["-p"]);
  assert.deepEqual(windowsShellGuard("codex", ["exec"], "darwin"), ["exec"]);
  assert.deepEqual(windowsShellGuard("C:\\Program Files\\nodejs\\node.exe", ["identity.js"], "win32"), ["identity.js"]);
});

test("spawnSession applies the guard before anything starts", () => {
  assert.throws(() => spawnSession("codex", ["exec"], { platform: "win32", env: {} }), e => e.code === "sandbox_failed");
});

test("on a real Windows machine a program named claude is started with the shell tools denied, and an agent without that way is refused", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  // node.exe copied to claude.exe: it does not know the option the guard puts first and says so on stderr, which proves what it was started with.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsh-"));
  try {
    const bin = path.join(dir, "claude.exe"); fs.copyFileSync(process.execPath, bin);
    const child = spawnSession(bin, ["-p", "hello"], { cwd: dir, env: { ...process.env } });
    let err = ""; child.stderr.on("data", d => err += d);
    await new Promise(r => child.on("close", r));
    assert.match(err, /--disallowedTools/, `the program was not started with the shell tools denied: ${err}`);
    fs.copyFileSync(process.execPath, path.join(dir, "codex.exe"));
    assert.throws(() => spawnSession(path.join(dir, "codex.exe"), ["exec"], { cwd: dir, env: {} }), e => e.code === "sandbox_failed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
