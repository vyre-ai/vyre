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

import { eventLine, actedVia, ASSISTANT_MARK } from "./kernel-view.js";
test("what the person's assistant did carries acted_via through to the line, and is marked after the person's name", () => {
  const ev = { id: 1, type: "record.updated", time: 5, actor: { id: "per_a1" }, acted_via: "assistant", data: { what: "changed this" } };
  assert.equal(eventLine(ev).via, "assistant");
  assert.equal(eventLine({ ...ev, acted_via: undefined }).via, undefined);
  assert.equal(actedVia({ ext: { acted_via: "assistant" } }), true);
  assert.equal(actedVia({ data: { acted_via: "assistant" } }), true);
  assert.equal(actedVia(null), false);
  assert.equal(ASSISTANT_MARK, "(Sent by Vyre Assistant)");
});
