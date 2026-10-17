// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installOwnedFromStatus, resolveInstallOnline } from "./install-online.js";

test("installOwnedFromStatus reads owned or locked from wink.install.status", () => {
  assert.equal(installOwnedFromStatus({ owned: true }), true);
  assert.equal(installOwnedFromStatus({ locked: true }), true);
  assert.equal(installOwnedFromStatus({ issued: true }), false);
  assert.equal(installOwnedFromStatus({ __error: "x" }), false);
});

test("resolveInstallOnline never stores state; agents do not call complete", async () => {
  const calls = [];
  const tryCall = async (name) => {
    calls.push(name);
    if (name === "wink.install.status") return { owned: calls.filter((c) => c === "wink.install.status").length > 1 };
    return { ok: true };
  };
  assert.equal(await resolveInstallOnline({ tryCall, meta: { caller: "mcp:agent:kit" } }), false);
  assert.deepEqual(calls, ["wink.install.status"]);
  calls.length = 0;
  assert.equal(await resolveInstallOnline({ tryCall, meta: { caller: "cli" } }), true);
  assert.deepEqual(calls, ["wink.install.status", "wink.install.complete", "wink.install.status"], "the server's own answer is what makes it online");
});

test("a pairing that has only started is not online, and a complete on the server itself is", async () => {
  const started = async (/** @type {string} */ name) => (name === "wink.install.status" ? { owned: false } : { ok: true, pairing: "pr_1" });
  assert.equal(await resolveInstallOnline({ tryCall: started, meta: { caller: "cli" } }), false);
  const here = async (/** @type {string} */ name) => (name === "wink.install.status" ? { owned: false } : { ok: true, owned: true, person: "per_x" });
  assert.equal(await resolveInstallOnline({ tryCall: here, meta: { caller: "cli" } }), true);
});

test("resolveInstallOnline reports a contested install line", async () => {
  const tryCall = async (/** @type {string} */ name) => (name === "wink.install.status" ? { owned: false } : { __error: "another server", __code: "contested" });
  const seen = /** @type {{ contested?: boolean }} */ ({});
  assert.equal(await resolveInstallOnline({ tryCall, meta: { caller: "cli" }, seen }), false);
  assert.equal(seen.contested, true);
});
