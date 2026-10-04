// peerIdentity: who a plain mcp caller is, from the kernel. Linux reads /proc; elsewhere the test is skipped (the macOS path is lsof and ps).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { peerIdentity } from "./peer.js";

const linux = process.platform === "linux";

test("peerIdentity: the claude ancestor's pid, start time and working folder, never the peer's own folder", { skip: !linux }, () => {
  const claude = process.pid, server = 4_000_001, shell = 4_000_002;
  const look = pid => ({ [server]: { ppid: claude, args: "node /opt/vyre/mcp.js" }, [shell]: { ppid: server, args: "bash -c curl" }, [claude]: { ppid: 1, args: "/usr/local/bin/claude -p" } })[pid] || null;
  const who = peerIdentity(shell, look, "linux");
  assert.equal(who.cwd, fs.readlinkSync(`/proc/${claude}/cwd`));
  assert.match(String(who.session), new RegExp(`^${claude}:\\d+$`));
  assert.equal(peerIdentity(shell, look, "linux").session, who.session, "stable for the life of the process");
});

test("peerIdentity: no claude above the peer verifies nothing, and an unknown platform says nothing", () => {
  const look = pid => ({ 7: { ppid: 1, args: "node server.js" } })[pid] || null;
  assert.deepEqual(peerIdentity(7, look, "linux"), { session: null, cwd: null });
  assert.deepEqual(peerIdentity(process.pid, () => ({ ppid: 1, args: "claude" }), "win32"), { session: null, cwd: null });
});
