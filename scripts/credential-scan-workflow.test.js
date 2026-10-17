// @ts-check
// .github/workflows/credential-scan.yml is the only place core/sessions/credential-scan.test.js runs for real (the node suite has no claude binary and skips it). What it must keep: the version is the computer
// image's pin, no secret and no write permission, the test files are the credential-scan ones (variants included), and a skip or an empty run fails the job.
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/credential-scan.yml"), "utf8");
const dockerfile = fs.readFileSync(path.join(ROOT, "core/computers/image/Dockerfile"), "utf8");

test("it installs the version the computer image pins, read from that Dockerfile, and checks the binary reports it", () => {
  assert.match(dockerfile, /^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m, "the image pins an exact version this job can read");
  assert.match(yml, /core\/computers\/image\/Dockerfile/);
  assert.match(yml, /@anthropic-ai\/claude-code@\$v/);
  assert.match(yml, /case "\$got" in "\$v"\*\)/, "an installed version that differs from the pin fails");
  assert.match(yml, /VYRE_CLAUDE_BIN=/);
});

test("a push starts it only when a file the proof depends on changed", () => {
  const push = yml.slice(yml.indexOf("\n  push:\n"), yml.indexOf("\n  pull_request:\n"));
  assert.match(push, /\n    paths:\n      - "core\/sessions\/\*\*"/, "the push trigger has a path filter");
});

test("it holds no secret, no environment and only read access", () => {
  assert.ok(!/secrets\.|environment:|id-token|contents: write/.test(yml));
  assert.match(yml, /\npermissions:\n  contents: read\n/);
});

test("it runs the credential-scan tests, variants included, and fails on a skip or an empty run", () => {
  assert.match(yml, /node --test [^\n]*core\/sessions\/credential-scan\*\.test\.js/);
  assert.match(yml, /\^ℹ skipped 0\$/, "a skip fails the job");
  assert.match(yml, /\^ℹ pass \[1-9\]/, "no passing test fails the job");
  assert.ok(fs.existsSync(path.join(ROOT, "core/sessions/credential-scan.test.js")));
});
