// @ts-check
// The Flows host tells the house about a task change (the Needs-you list redraws), through the events bus. The bus writes into the kernel log too, which the host also watches: a change the host
// itself published must not be published again, or it loops forever (9 Oct: stop() never returned). One task.completed is published once, and the count stays put.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("a task.completed is published to the house exactly once, and stop() returns", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  let stopped = false;
  t.after(async () => { if (!stopped) await d.stop(); });
  const me = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-p", person: d.kernel.id.owner, path: "direct", session: "s" });
  const gw = d.kernel.gateway, space = d.kernel.id.space;
  const task = await gw.ask.request(me, { title: "Decide once", doer: { kind: "agent", id: "assistant", space }, output: { kind: "decision" } });
  const s = await d.kernel.surfaces.open(me, { agent: "assistant", ttl_ms: 60_000 });
  const ac = await d.kernel.surfaces.chainFor(s.token);
  await gw.ask.start(ac, task.id);
  await gw.ask.complete(ac, task.id, { answer: "yes", reason: "once" });
  const published = () => d.kernel.log.read({ type: "task.completed" }).filter((/** @type {any} */ e) => /\/event\/flows$/.test(String(e.subject))).length;
  await new Promise(r => setTimeout(r, 1500));
  const first = published();
  assert.equal(first, 1, "published once");
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(published(), first, "and it does not grow");
  await d.stop();
  stopped = true;
});
