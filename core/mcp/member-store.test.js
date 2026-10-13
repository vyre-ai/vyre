// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { memberStore, keyFromDevice, memberMcpConfig } from "./member-store.js";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mstore-"));
const key = () => keyFromDevice(crypto.randomBytes(32), "space-1");

test("a member's servers round-trip, sealed on disk, 0600", () => {
  const root = dir(), s = memberStore({ root, space: "space-1", key: key() });
  s.put("alice", "gmail", { type: "http", url: "https://gmailmcp.googleapis.com/mcp/v1", token: "SECRET-TOKEN" });
  assert.deepEqual(s.list("alice").map(x => x.name), ["gmail"]);
  assert.equal(s.get("alice", "gmail").token, "SECRET-TOKEN");
  const files = fs.readdirSync(root, { recursive: true }).map(String).filter(f => fs.statSync(path.join(root, f)).isFile());
  assert.ok(files.length >= 1);
  for (const f of files) {
    const raw = fs.readFileSync(path.join(root, f));
    assert.ok(!raw.includes("SECRET-TOKEN") && !raw.includes("gmailmcp"), "ciphertext only");
    assert.equal(fs.statSync(path.join(root, f)).mode & 0o077, 0);
  }
});

test("one member cannot read another's, nor the same file under another key", () => {
  const root = dir(), k = key(), s = memberStore({ root, space: "space-1", key: k });
  s.put("alice", "gmail", { type: "http", url: "https://x.example/mcp" });
  assert.deepEqual(s.list("bob"), []);
  assert.equal(s.get("bob", "gmail"), null);
  const other = memberStore({ root, space: "space-1", key: key() });
  assert.deepEqual(other.list("alice"), []);   // wrong key: nothing, no throw
  const wrongSpace = memberStore({ root, space: "space-2", key: k });
  assert.deepEqual(wrongSpace.list("alice"), []);
});

test("remove deletes; a hostile id or name cannot leave the folder", () => {
  const root = dir(), s = memberStore({ root, space: "s", key: key() });
  s.put("alice", "a", { type: "http", url: "https://x.example/mcp" });
  assert.equal(s.remove("alice", "a"), true);
  assert.equal(s.remove("alice", "a"), false);
  assert.throws(() => s.put("../evil", "a", {}), /identity/);
  assert.throws(() => s.put("alice", "../a", {}), /name/);
});

test("memberMcpConfig builds a --mcp-config object without leaking into the owner's vyre entry", () => {
  const root = dir(), s = memberStore({ root, space: "s", key: key() });
  s.put("alice", "gmail", { type: "http", url: "https://x.example/mcp", headers: { authorization: "Bearer T" } });
  const cfg = memberMcpConfig(s, "alice");
  assert.equal(cfg.mcpServers.gmail.url, "https://x.example/mcp");
  assert.deepEqual(memberMcpConfig(s, "bob"), { mcpServers: {} });
  assert.throws(() => s.put("alice", "vyre", { type: "http", url: "https://x.example/" }), /reserved/);
});

import { mergeMcpServers } from "./member-store.js";
test("mergeMcpServers: Vyre's entry wins a clash; no member servers changes nothing", () => {
  const v = { vyre: { command: "node" } };
  assert.deepEqual(mergeMcpServers(v, null), v);
  assert.deepEqual(mergeMcpServers(v, { mcpServers: { vyre: { command: "evil" }, gmail: { url: "u" } } }), { gmail: { url: "u" }, vyre: { command: "node" } });
});
