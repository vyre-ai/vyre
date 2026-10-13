// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOUNT_TOOLS, mountCallable, mountView } from "./mount-model.js";

test("the page makes only the Drive's mount tools for the file extension, never a real delete or a restore", () => {
  for (const t of MOUNT_TOOLS) assert.ok(mountCallable(t), t);
  for (const t of ["files.drive.delete", "files.drive.restore", "files.drive.space.list", "vault.reveal", "", null, 3, "files.drive.space.trash "]) assert.equal(mountCallable(t), false, String(t));
  assert.ok(MOUNT_TOOLS.includes("files.drive.space.trash") && !MOUNT_TOOLS.some(t => /delete|restore|share/.test(t)));
});

test("Settings shows the switch only where this build can do it, in the words of the place", () => {
  assert.equal(mountView("mac", null).show, false);
  assert.equal(mountView(null, { supported: true }).show, false);
  assert.equal(mountView("mac", { supported: false }).show, false, "a build without the extension shows nothing");
  const off = mountView("mac", { supported: true, on: false, paired: true });
  assert.deepEqual([off.show, off.on, off.title, off.button, off.enabled], [true, false, "Show Vyre in Finder", "Show", true]);
  const on = mountView("windows", { supported: true, on: true, paired: true });
  assert.deepEqual([on.title, on.button], ["Show Vyre in File Explorer", "Stop showing"]);
  assert.match(on.sub, /trash on your server/);
  const unpaired = mountView("windows", { supported: true, on: false, paired: false });
  assert.deepEqual([unpaired.enabled, unpaired.sub], [false, "Pair this computer with your Vyre first."]);
});
