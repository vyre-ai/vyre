// @ts-check
// Tasks survive a restart (devbox, 4 Oct): they lived in memory only, so every redeploy emptied tasks.list while records stayed. The log now carries each task after every change and the kernel
// rebuilds them at start. A real daemon on a temp home, restarted; a test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { seed } from "../core/records-tools/dev-seed.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("two seeded tasks (one waiting for the person's check, one an assistant works) are listed again after the kernel restarts, in the same states", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, log: () => {}, kernel: true });
  const me = (/** @type {any} */ x) => x.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-r", person: x.kernel.id.owner, path: "direct", session: "s" });
  const seeded = await seed({ gateway: d.kernel.gateway, surfaces: d.kernel.surfaces, chain: me(d), space: d.kernel.id.space });
  const before = (await d.kernel.gateway.ask.list(me(d), {})).map((/** @type {any} */ x) => [x.id, x.state]).sort();
  assert.equal(before.length, 2);
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const after = (await d.kernel.gateway.ask.list(me(d), {})).map((/** @type {any} */ x) => [x.id, x.state]).sort();
  assert.deepEqual(after, before, "the same two tasks in the same states");
  assert.deepEqual((await d.kernel.gateway.ask.needsYou(me(d))).map((/** @type {any} */ x) => x.id), [seeded.tasks.approval], "the approval still waits for the person");
  // and it can still be worked: the doer starts the other one
  const card = await d.kernel.gateway.ask.card(me(d), seeded.tasks.approval);
  assert.ok(card, "the approval card is rebuilt from the stored body");
});
