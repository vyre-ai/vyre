// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensure, read } from "./index.js";

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vy-bearer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("bearer.ensure: makes a long random token, 0400, and returns the same one on a second call", t => {
  const file = path.join(tmp(t), "sub", "docker-api-bearer");
  const a = ensure(file);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o400);
  const b = ensure(file);
  assert.equal(a, b, "a second ensure() does not rotate an existing token");
});

test("bearer.ensure: two different files never collide", t => {
  const dir = tmp(t);
  const a = ensure(path.join(dir, "a"));
  const b = ensure(path.join(dir, "b"));
  assert.notEqual(a, b);
});

test("bearer.read: sees a token ensure() already wrote", async t => {
  const file = path.join(tmp(t), "bearer");
  const token = ensure(file);
  assert.equal(await read(file, { timeoutMs: 1000 }), token);
});

test("bearer.read: trims a trailing newline (a shell echo might leave one)", async t => {
  const file = path.join(tmp(t), "bearer");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "abc123\n");
  assert.equal(await read(file, { timeoutMs: 1000 }), "abc123");
});

test("bearer.read: waits for a file that appears after a short delay, instead of failing at once", async t => {
  const file = path.join(tmp(t), "bearer");
  const p = read(file, { timeoutMs: 2000, stepMs: 50 });
  await new Promise(r => setTimeout(r, 150));
  const token = ensure(file);
  assert.equal(await p, token);
});

test("bearer.read: gives up after timeoutMs when nothing ever writes the file", async t => {
  const file = path.join(tmp(t), "never");
  await assert.rejects(read(file, { timeoutMs: 200, stepMs: 50 }), /no bearer/);
});
