// @ts-check
// Tasks survive a restart (devbox, 4 Oct): they lived in memory only, so every redeploy emptied tasks.list while records stayed. The log now carries each task after every change and the kernel
// rebuilds them at start. A real daemon on a temp home, restarted; a test box, never a Mac.
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
  const expected = before.map(([id, st]) => [id, st === "needs_check" ? "ready" : st]);
  assert.deepEqual(after, expected, "the same two tasks; the one waiting for its check goes back to ready (its answer text is never in the log, so its card cannot be rebuilt)");
  assert.deepEqual((await d.kernel.gateway.ask.needsYou(me(d))).map((/** @type {any} */ x) => x.id), [], "nothing waits for the person's check until the doer hands it in again");
});

test("TR-1: free text a doer hands in with a decision (a social security number in the reason) is never written to the log", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const me = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-r", person: d.kernel.id.owner, path: "direct", session: "s" });
  const seeded = await seed({ gateway: d.kernel.gateway, surfaces: d.kernel.surfaces, chain: me, space: d.kernel.id.space });
  const gw = d.kernel.gateway;
  // the seeded approval already holds a decision waiting for its check; hand a second one in with sensitive text
  const t2 = await gw.ask.request(me, { title: "Check the file", doer: { kind: "agent", id: "assistant", space: d.kernel.id.space }, checker: { kind: "person", id: d.kernel.id.owner, space: d.kernel.id.space }, output: { kind: "decision" } });
  const s1 = await d.kernel.surfaces.open(me, { agent: "assistant", ttl_ms: 60_000 });
  const ac = await d.kernel.surfaces.chainFor(s1.token);
  await gw.ask.start(ac, t2.id);
  await gw.ask.complete(ac, t2.id, { answer: "yes", reason: "the client's ssn 123-45-6789 matches" });
  const logged = JSON.stringify(d.kernel.log.read({ type: "task.*" }));
  assert.ok(!logged.includes("123-45-6789"), "the number is in the log: " + logged.slice(0, 300));
  void seeded;
});
