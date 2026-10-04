// @ts-check
// The box service runs as 0:0 with every capability dropped but SETUID/SETGID (its entrypoint drops to the vyre user), so a one-off `compose run --entrypoint node` is root WITHOUT DAC_OVERRIDE and cannot read the vyre-owned
// home (0700): `sudo vyre admin anchor-reset` said "no Vyre home" and `admin wipe` could not touch the home on a real packaged install (found on testbox6, 5 Oct). Every one-off run that executes node against the home must name
// `-u vyre`. (A one-off run through the default entrypoint, like restore, drops privileges itself; a `--entrypoint test` only checks a file exists.)
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("box/vyre: every one-off `compose run --entrypoint node` runs as the vyre user", () => {
  const lines = fs.readFileSync(path.join(ROOT, "box", "vyre"), "utf8").split("\n").filter(l => /compose run\b/.test(l) && /--entrypoint node\b/.test(l));
  assert.ok(lines.length >= 2, "the wrapper has its admin one-off runs (wipe, anchor-reset)");
  for (const l of lines) assert.match(l, /\s-u vyre\s/, `a one-off node run needs -u vyre: ${l.trim().slice(0, 120)}`);
});
