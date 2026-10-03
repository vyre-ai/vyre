// @ts-check
// Settings > Network > VyreDrive: each share's own access (an old box's global one when a share
// does not say), the secrets warning from files.drive.audit's `unsafe`, and the remount step
// files.drive.access answers with.

import test from "node:test";
import assert from "node:assert/strict";
import { shareAccess, accessWord, flip, perShare, unsafeLines, mountHint } from "../js/drive-rows.js";

test("drive rows: a share's own access wins; an old box's global access fills in", () => {
  assert.equal(shareAccess({ name: "projects", access: "rw" }, { access: "ro" }), "rw");
  assert.equal(shareAccess({ name: "projects", access: "ro" }, { access: "rw" }), "ro");
  assert.equal(shareAccess({ name: "projects" }, { access: "rw" }), "rw", "old box: the global access");
  assert.equal(shareAccess({ name: "projects" }, {}), "ro");
  assert.equal(shareAccess(null, undefined), "ro");
  assert.equal(shareAccess({ access: "sideways" }, { access: "rw" }), "rw", "an unknown value is not trusted");
  assert.equal(accessWord("rw"), "Read and write");
  assert.equal(accessWord("ro"), "Read only");
  assert.equal(flip("ro"), "rw");
  assert.equal(flip("rw"), "ro");
});

test("drive rows: the switch shows only where the status rows carry their own access", () => {
  assert.equal(perShare([{ name: "projects", access: "ro" }, { name: "glass-files" }]), true);
  assert.equal(perShare([{ name: "projects" }, { name: "glass-files" }]), false, "an old box");
  assert.equal(perShare(/** @type {any} */ (undefined)), false);
});

test("drive rows: a share with secrets inside gets a line; one too big to check says why", () => {
  assert.deepEqual(unsafeLines({ unsafe: [{ share: "projects", found: [".env", ".git/config"] }] }),
    [{ share: "projects", text: "projects has secrets inside: .env, .git/config" }]);
  assert.deepEqual(unsafeLines({ unsafe: [{ share: "glass-files", found: [], why: "more than 20000 files and folders, too many to check" }] }),
    [{ share: "glass-files", text: "glass-files could not be checked for secrets: more than 20000 files and folders, too many to check." }]);
  assert.equal(unsafeLines({ unsafe: [{ share: "projects", found: [".env"], why: "too many to check" }] })[0].text,
    "projects could not be checked for secrets: too many to check. Found so far: .env.");
  assert.deepEqual(unsafeLines({ findings: [] }), [], "an old box has no unsafe");
  assert.deepEqual(unsafeLines(null), []);
  assert.deepEqual(unsafeLines({ unsafe: [{ found: [".env"] }, null] }), [], "a row without a share is dropped");
});

test("drive rows: the remount line only when your server's mount has to change", () => {
  const step = "Set VYRE_DRIVE_ACCESS=rw in your server's .env, then run docker compose up -d";
  assert.deepEqual(mountHint({ name: "projects", access: "rw", mount: { want: "rw", now: "ro", change: true, step } }), { line: "Remount on your Mac", step });
  assert.deepEqual(mountHint({ mount: { want: "rw", now: "unknown", change: true } }), { line: "Remount on your Mac", step: null });
  assert.equal(mountHint({ name: "projects", access: "ro", mount: { want: "ro", now: "ro", change: false } }), null);
  assert.equal(mountHint({ name: "projects", access: "ro" }), null);
  assert.equal(mountHint(null), null);
});
