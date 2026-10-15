// @ts-check
// The first-run gate (scripts/mac-first-run-proof.mjs, .github/workflows/first-run.yml) stays a gate: 0.5.0 shipped stuck at Vault on a device with no server, and nothing walked the screens.
// A release that has not passed the walk must not publish, the walk must not be allowed to fail quietly, and the proof's ports must be the ones its web build was made with.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ p) => fs.readFileSync(path.join(REPO, p), "utf8");
const release = read(".github/workflows/release.yml"), firstRun = read(".github/workflows/first-run.yml"), script = read("scripts/mac-first-run-proof.mjs");

test("release.yml runs the first-run walk and the release job needs it to succeed (not skipped)", () => {
  assert.match(release, /\n  first-run:\n    needs: prepare\n    uses: \.\/\.github\/workflows\/first-run\.yml/, "a first-run job calls the reusable workflow");
  const rel = release.slice(release.indexOf("\n  release:\n"));
  assert.match(rel.split("\n").slice(0, 4).join("\n"), /needs: \[[^\]]*\bfirst-run\b[^\]]*\]/, "the release job needs first-run");
  assert.match(rel, /needs\.first-run\.result == 'success'/, "the release job's condition requires first-run to have succeeded");
  assert.doesNotMatch(rel, /needs\.first-run\.result == 'skipped'/, "a skipped first-run does not pass the release");
});

test("the walk cannot fail quietly: no continue-on-error, a pipe keeps its exit code, the artifacts are kept", () => {
  assert.doesNotMatch(firstRun, /continue-on-error/);
  const walk = firstRun.slice(firstRun.indexOf("- name: The walk"));
  assert.match(walk, /shell: bash/, "the walk runs under bash -eo pipefail, so tee does not hide a failure");
  assert.match(walk, /if: always\(\)/, "the screens and the log are uploaded when the walk fails");
});

test("the walk covers the four screens the owner named: name, Create, Vault, Ready", () => {
  for (const t of ["Pick your name", "Create a space or join one", "Do the four words match?", "Let's set up your vault", "You are in "]) assert.ok(script.includes(t), `the walk looks for "${t}"`);
  assert.ok(script.indexOf("Create a space or join one") < script.indexOf("Let's set up your vault"), "with no server the Space comes before the Vault");
});

test("the proof's default ports are the ones the web build is pointed at", () => {
  const names = /FIRST_RUN_NAMES_PORT: "(\d+)"/.exec(firstRun)?.[1], relay = /FIRST_RUN_RELAY_PORT: "(\d+)"/.exec(firstRun)?.[1];
  assert.ok(names && relay, "the workflow names both ports");
  assert.match(script, new RegExp(`"--names-port", "${names}"`));
  assert.match(script, new RegExp(`"--relay-port", "${relay}"`));
});
