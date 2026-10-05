// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// This file is its own process under node --test, so the flag is set before store.js is first read.
/** @type {any} */ (globalThis).__VYRE_APP__ = true;
const { getStore, setStore, allowMock } = await import("./store.js");

test("in the app there is no mock unless a dev or capture build asked for it", async () => {
  setStore(null);
  assert.throws(() => getStore(), (e) => /** @type {any} */ (e).code === "offline" && /Not connected/.test(e.message));
  allowMock();
  setStore(null);
  assert.ok((await getStore().spaces()).length > 0);
});
