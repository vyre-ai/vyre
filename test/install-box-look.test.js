// @ts-check
// The installer's look: numbered steps, a check per step, a finish. Plain ASCII off a terminal,
// colour on one. The behaviour is covered in core/names/system.test.js; this is only the talk.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "install-box.sh");

/** A temp box with stub uname, id, docker and sudo, and the stack and wrapper paths in it. */
function box(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-look-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const stubs = {
    uname: "echo Linux",
    id: 'case "$1" in -u) echo 1000 ;; -un|-gn) echo alex ;; *) exit 1 ;; esac',
    docker: 'case "$1 $2" in "compose version") echo 2.29.1 ;; esac; exit 0',
    sudo: 'exec "$@"',
  };
  for (const [name, body] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return {
    PATH: `${bin}:/usr/bin:/bin`, HOME: base, VYRE_DIR: path.join(base, "srv", "vyre"),
    VYRE_WRAPPER: path.join(base, "bin-out", "vyre"), VYRE_DOCKER_SOCK: path.join(base, "none"),
  };
}

const run = (env, args) => spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });

test("install-box.sh look: plain output has steps, checks and a finish, and no escapes or Unicode", t => {
  const r = run(box(t), ["--dry-run", "--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/[^\x09\x0a\x20-\x7e]/.test(r.stdout), `plain output is printable ASCII:\n${r.stdout}`);
  const lines = r.stdout.split("\n");
  const titles = ["Checking Docker", "Reading the box files", "Laying out ", "Installing the vyre command", "Starting Vyre"];
  let at = -1;
  titles.forEach((title, i) => {
    const n = lines.findIndex(l => l.startsWith(`[${i + 1}/5] ${title}`));
    assert.ok(n > at, `step ${i + 1} in order:\n${r.stdout}`);
    at = n;
  });
  assert.equal(lines.filter(l => /^ {2}ok /.test(l)).length, 5, r.stdout);
  assert.match(r.stdout, /^would run: env VYRE_DIR=/m, "the would-run lines stay");
  assert.match(r.stdout, /That's the whole plan\./);
  const last = r.stdout.split("\n").filter(l => l.trim()).pop();
  assert.equal(last, "  Run it again without --dry-run when you're ready.", "the last printed line is the next step, not a send-off");
  assert.ok(!/best work|keep the thread|end the week/.test(r.stdout), "no sign-off");
});

test("install-box.sh look: NO_COLOR and CI stay plain; VYRE_NO_UP has four steps", t => {
  for (const extra of [{ NO_COLOR: "1" }, { CI: "1" }, { TERM: "dumb" }]) {
    const r = run({ ...box(t), ...extra }, ["--dry-run", "--yes", "--from", REPO]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes("\x1b"), JSON.stringify(extra));
  }
  const r = run({ ...box(t), VYRE_NO_UP: "1" }, ["--dry-run", "--yes", "--from", REPO]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\[4\/4\] Installing the vyre command$/m);
  assert.ok(!r.stdout.includes("Starting Vyre"));
  assert.match(r.stdout, /not started \(VYRE_NO_UP=1\)/);
});

test("install-box.sh look: on a terminal it is in colour, with the mark and a check", t => {
  const probe = spawnSync("script", ["-qc", "true", "/dev/null"], { stdio: "ignore" });
  if (probe.status !== 0) { t.skip("no util-linux script here"); return; }
  const env = { ...box(t), TERM: "xterm-256color" };
  const cmd = `sh ${SCRIPT} --dry-run --yes --from ${REPO}`;
  const r = spawnSync("script", ["-qc", cmd, "/dev/null"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("\x1b[38;2;198;243;107m•"), "the signal dot");
  assert.ok(r.stdout.includes("✓"), "a check mark");
  assert.match(r.stdout, /would run: env VYRE_DIR=/);
});

test("install-box.sh --print-link still writes .env's lines into the file, not to the terminal", t => {
  // In --print-link mode say() talks on stderr; the .env block used say, so the file came out
  // empty and compose fell back to pulling an image that is not published (e2e2's matrix, 30 Sep).
  const r = run(box(t), ["--dry-run", "--yes", "--from", REPO, "--print-link"]);
  assert.equal(r.status, 0, r.stderr);
  const all = r.stdout + r.stderr;
  assert.match(all, /^ {2}COMPOSE_FILE=compose\.yml:compose\.build\.yml$/m, `the dry run shows the file's own lines:\n${all}`);
  assert.match(all, /^ {2}COMPOSE_PROJECT_NAME=vyre$/m, all);
});
