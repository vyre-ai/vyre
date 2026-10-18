// @ts-check
// The fscrypt volume of the test jobs is mounted on the runner's own path outside /home (/mnt/fsc-<runner name>) and unmounted at the end. It used to be /mnt/fsc, one path for the six runners of a host: every job stacked its loop mount on the
// one before (150 to 260 dead mounts per host, images deleted, mounts never removed), each job's tests saw the newest job's volume, and an unmount found another job's files open (the workspace reds of 18 Oct 2026).
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of ["node.yml", "test-files.yml"]) {
  const yml = fs.readFileSync(path.join(ROOT, ".github/workflows", file), "utf8");
  test(`${file}: the fscrypt volume is this job's own and is unmounted when the job ends`, () => {
    assert.ok(!/\/mnt\/fsc(?!-)/.test(yml), "no path shared with other runners");
    assert.match(yml, /fsc="\/mnt\/fsc-\$\(printf '%s' "\$RUNNER_NAME" \| tr -c 'A-Za-z0-9_\.-' '-'\)"/, "the runner's own path, outside /home (the sandbox plan refuses a writable bind under /home)");
    assert.ok(!/RUNNER_TEMP\/fsc"/.test(yml.replace(/RUNNER_TEMP\/fsc\.img/g, "")), "the volume is not under the runner's temp folder, which is under /home");
    assert.match(yml, /while mountpoint -q "\$fsc"; do sudo umount -l "\$fsc" \|\| break; done/, "a mount left by a killed job goes first");
    assert.match(yml, /mount -o loop "\$RUNNER_TEMP\/fsc\.img" "\$fsc"/);
    assert.match(yml, /VYRE_FSCRYPT_DIR=\$fsc" >> "\$GITHUB_ENV"/);
    assert.match(yml, /- name: Unmount the job's volume\n        if: \$\{\{ always\(\) \}\}\n        run: \|\n          case "\$VYRE_FSCRYPT_DIR" in \/mnt\/fsc-\*\) sudo umount -l "\$VYRE_FSCRYPT_DIR" 2>\/dev\/null \|\| true; sudo rmdir "\$VYRE_FSCRYPT_DIR"/);
  });
}
