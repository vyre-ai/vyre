// @ts-check
// The dialog gate: under node --test (or VYRE_NO_DIALOGS=1) a real helper that could raise a
// system dialog refuses before it is built or spawned. Nothing here builds or runs a helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dialogsAllowed, checkDialog, NO_DIALOGS } from "./dialogs.js";
import { Helper } from "./helper.js";

test("dialogsAllowed: off under tests unless asked for, and off whenever VYRE_NO_DIALOGS=1", () => {
  assert.equal(dialogsAllowed({}), true);
  assert.equal(dialogsAllowed({ NODE_TEST_CONTEXT: "child" }), false);
  assert.equal(dialogsAllowed({ NODE_TEST_CONTEXT: "child", VYRE_TEST_DIALOGS: "1" }), true);
  assert.equal(dialogsAllowed({ VYRE_NO_DIALOGS: "1" }), false);
  assert.equal(dialogsAllowed({ NODE_TEST_CONTEXT: "child", VYRE_TEST_DIALOGS: "1", VYRE_NO_DIALOGS: "1" }), false);
  assert.equal(dialogsAllowed(), false, "this test runs under node --test");
});

test("checkDialog: which requests would ask a person", () => {
  const off = { VYRE_NO_DIALOGS: "1" };
  const refused = (name, req) => assert.throws(() => checkDialog(name, req, off), e => /** @type {any} */ (e).code === "presence_required" && e.message === NO_DIALOGS, `${name} ${JSON.stringify(req)}`);
  refused("enclave", { op: "auth", reason: "x" });
  refused("enclave", { op: "derive" });
  refused("type", { bundle: "com.apple.Safari" });
  refused("keychain", { op: "read" });
  refused("keychain", { op: "write", noUI: false });
  for (const [n, r] of [["enclave", { op: "create" }], ["enclave", { op: "available" }], ["keychain", { op: "read", noUI: true }], ["clip", { op: "copy" }], ["watch", undefined]]) {
    assert.doesNotThrow(() => checkDialog(n, r, off), n);
  }
  assert.doesNotThrow(() => checkDialog("enclave", { op: "auth" }, {}));
});

test("the real enclave, type and keychain helpers refuse before spawn under tests", async t => {
  assert.ok(!process.env.VYRE_TEST_DIALOGS, "run without VYRE_TEST_DIALOGS");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-dlg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // swiftc is pointed at /usr/bin/false: had the check come after the build, this would say so.
  const h = name => new Helper({ name: /** @type {any} */ (name), dir: path.join(dir, "helpers"), swiftc: "/usr/bin/false", platform: "darwin" });
  const refused = e => /** @type {any} */ (e).code === "presence_required" && e.message === NO_DIALOGS;
  await assert.rejects(h("enclave").spawn([], { request: { op: "auth", reason: "x" } }), refused);
  await assert.rejects(h("enclave").spawn([], { request: { op: "derive" } }), refused);
  await assert.rejects(h("type").spawn([]), refused);
  await assert.rejects(h("keychain").spawn([], { request: { op: "read" } }), refused);
  await assert.rejects(h("keychain").spawn([]), refused);
  assert.ok(!fs.existsSync(path.join(dir, "helpers")), "nothing was built");
  // With noUI the keychain helper goes on to build (and fails here only because swiftc is false).
  await assert.rejects(h("keychain").spawn([], { request: { op: "read", noUI: true } }), /could not build|not found/);
});
