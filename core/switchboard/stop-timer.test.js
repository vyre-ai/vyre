// @ts-check
// A home stopped before the Switchboard's start-up timers fire: nothing fires afterwards (no `database is not open`, no unhandled rejection).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

test("stopping the daemon right after start leaves no Switchboard timer to fire on a closed database", { timeout: 30_000 }, async t => {
  const root = tempHome(t);
  const seen = /** @type {any[]} */ ([]);
  const onErr = (/** @type {any} */ e) => seen.push(e);
  process.on("uncaughtException", onErr); process.on("unhandledRejection", onErr);
  t.after(() => { process.off("uncaughtException", onErr); process.off("unhandledRejection", onErr); });
  const d = await start({ root, log: () => {} });
  await d.stop();
  await new Promise(r => setTimeout(r, 2200));
  assert.deepEqual(seen.map(e => String(e && e.message || e)), []);
});
