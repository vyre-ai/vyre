// @ts-check
// openInBrowser: the shared "open a URL" spawn every command that opens a browser calls
// (up.js, box.js, connect.js, vault.js). Security review (reviewer, 0.1.1): cmd.exe parses an
// unquoted argument, so a query string's `&`/`|`/`^`/`<`/`>` would run as command operators if
// this ever built a `cmd /c start` line; every OAuth URL has a `&`. Fixed by never touching a
// shell on win32 and by refusing every scheme but http(s), on every platform.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openInBrowser } from "./kit.js";

/** A fake spawn that records the call instead of launching anything, and returns a fake child. */
function recordingSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() {} };
  };
}

test("openInBrowser: a query string with & reaches argv as one entry, on every platform", () => {
  const url = "https://x/?a=1&b=2";
  for (const platform of ["darwin", "win32", "linux"]) {
    const calls = [];
    openInBrowser(url, { platform, spawn: recordingSpawn(calls), env: {} });
    assert.equal(calls.length, 1, platform);
    assert.ok(calls[0].args.includes(url), `${platform}: the full URL is one argv entry, not split on &`);
  }
});

test("openInBrowser: win32 never touches a shell, and the URL is not parsed by cmd.exe", () => {
  const calls = [];
  openInBrowser("https://x/?a=1&b=2&c=calc.exe", { platform: "win32", spawn: recordingSpawn(calls), env: {} });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].cmd, "cmd", "no cmd.exe in the middle to parse & as an operator");
  assert.ok(!calls[0].opts?.shell, "spawn is never told to use a shell");
});

test("openInBrowser: darwin uses open, linux uses xdg-open, win32 uses rundll32's FileProtocolHandler", () => {
  for (const [platform, cmd] of [["darwin", "open"], ["linux", "xdg-open"], ["win32", "rundll32"]]) {
    const calls = [];
    openInBrowser("https://x/", { platform, spawn: recordingSpawn(calls), env: {} });
    assert.equal(calls[0].cmd, cmd, platform);
  }
  const calls = [];
  openInBrowser("https://x/", { platform: "win32", spawn: recordingSpawn(calls), env: {} });
  assert.deepEqual(calls[0].args, ["url.dll,FileProtocolHandler", "https://x/"]);
});

test("openInBrowser: file: and javascript: are refused, on every platform, custom bin or not", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const scheme of ["file:///etc/passwd", "javascript:alert(1)", "not a url at all"]) {
      const calls = [];
      openInBrowser(scheme, { platform, spawn: recordingSpawn(calls), env: {} });
      assert.equal(calls.length, 0, `${platform} ${scheme}`);
    }
    const calls = [];
    openInBrowser("file:///etc/passwd", { platform, spawn: recordingSpawn(calls), env: { VYRE_OPEN_BIN: "/bin/echo" } });
    assert.equal(calls.length, 0, `${platform}: VYRE_OPEN_BIN does not bypass the scheme check`);
  }
});

test("openInBrowser: what is spawned is the parsed href, not the raw string (reviewer nit)", () => {
  const calls = [];
  // A leading/trailing control character a raw string could carry; new URL() strips it, so it
  // must never reach the spawned argv either.
  openInBrowser("\u0000https://x/?a=1&b=2 \t", { platform: "linux", spawn: recordingSpawn(calls), env: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "https://x/?a=1&b=2", "the raw whitespace/control bytes are gone");
});

test("openInBrowser: http(s) still opens through a custom VYRE_OPEN_BIN", () => {
  const calls = [];
  openInBrowser("https://x/?a=1&b=2", { platform: "win32", spawn: recordingSpawn(calls), env: { VYRE_OPEN_BIN: "/bin/echo" } });
  assert.deepEqual(calls[0], { cmd: "/bin/echo", args: ["https://x/?a=1&b=2"], opts: calls[0].opts });
});
