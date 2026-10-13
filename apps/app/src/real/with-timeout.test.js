// @ts-check
// A server that does not answer (stopped, or off the network) must not hang a screen: with several servers paired a call waits a set time, then is refused in words that name the next step. The call is never sent to another server.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout, OFFLINE } from "./with-timeout.js";

test("a call that answers in time gives its answer", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
});

test("a call that never answers is refused as server_offline with a next step, after the wait", async () => {
  const t0 = Date.now();
  await assert.rejects(withTimeout(new Promise(() => {}), 40), (/** @type {any} */ e) => e.code === "server_offline" && /Check that it is on/.test(e.message) && e.message === OFFLINE);
  assert.ok(Date.now() - t0 >= 35);
});

test("a call that fails keeps its own error", async () => {
  await assert.rejects(withTimeout(Promise.reject(Object.assign(new Error("no"), { code: "forbidden" })), 50), (/** @type {any} */ e) => e.code === "forbidden");
});

test("peerCall waits only when several servers are paired, and drops the stuck connection so the next call reopens it", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./peer.ts", import.meta.url), "utf8");
  assert.match(src, /several \? await withTimeout\(/);
  assert.match(src, /peers\.delete\(id\)/);
});
