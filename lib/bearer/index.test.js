// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensure, read, watch } from "./index.js";

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

test("bearer: read, patient, waits quietly past the quick window and returns once vyred writes it", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vy-bearer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "docker-api-bearer");
  let waited = 0;
  const got = read(file, { timeoutMs: 50, stepMs: 10, patient: true, slowStepMs: 40, onWait: () => { waited++; } });
  await new Promise(r => setTimeout(r, 150));
  ensure(file);
  assert.equal((await got).length, 64);
  assert.equal(waited, 1, "said once that it slowed down, not on every look");
  await assert.rejects(read(path.join(dir, "missing"), { timeoutMs: 30, stepMs: 10 }), /no bearer after/, "not patient: still throws");
});

test("bearer.watch: answers null until the file is there, sees it once written, and reads the disk again at most once per gap", t => {
  const file = path.join(tmp(t), "secrets", "docker-api-bearer");
  let now = 0;
  const w = watch(file, { minGapMs: 1000, now: () => now });
  assert.equal(w.current(), null, "no file yet");
  const token = ensure(file);
  assert.equal(w.refresh(), null, "inside the gap the disk is not read again");
  now = 1000;
  assert.equal(w.refresh(), token);
  assert.equal(w.current(), token);
  fs.rmSync(file);
  const next = ensure(file);
  now = 1500;
  assert.equal(w.refresh(), token, "still inside the gap");
  now = 2000;
  assert.equal(w.refresh(), next, "a file vyred made again is picked up");
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "short\n");
  now = 3000;
  assert.equal(w.refresh(), null, "a token under 16 characters is no token");
});
