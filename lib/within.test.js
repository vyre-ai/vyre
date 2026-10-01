import test from "node:test";
import assert from "node:assert/strict";
import { within, withinOrThrow } from "./within.js";

test("within: the answer when it is in time, late when it is not, and the clock never outlives the call", async () => {
  assert.equal(await within(Promise.resolve(7), 5000), 7);
  assert.equal(await within(new Promise(() => {}), 20), null);
  assert.equal(await within(new Promise(() => {}), 20, "late"), "late");
  await assert.rejects(within(Promise.reject(new Error("no")), 5000), /no/);
  // A quick answer cleared its 10 minute timer: this test would not exit otherwise.
  await within(Promise.resolve(1), 600_000);
});

test("within: a pending wait keeps the event loop alive until the limit", async () => {
  // A child whose only pending work is within(): it must print "late", not exit early with the promise pending.
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { within } from ${JSON.stringify(new URL("./within.js", import.meta.url).href)}; console.log(await within(new Promise(() => {}), 200, "late"));`], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "late");
});

test("withinOrThrow: rejects with the caller's error at the limit", async () => {
  assert.equal(await withinOrThrow(Promise.resolve("ok"), 5000, () => new Error("slow")), "ok");
  await assert.rejects(withinOrThrow(new Promise(() => {}), 20, () => Object.assign(new Error("slow"), { code: "x" })), /slow/);
});
