// @ts-check
// The public gate hands the name directory (name, value) for an ACME challenge. 0.2.9 forwarded the name as the challenge value, the directory refused it ("not an ACME
// challenge value"), and no box got a certificate or a published address. This holds the adapter to the gate's own call shape.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameDirectory } from "./index.js";

test("name directory: the gate's acme(name, value) sends the challenge value, not the name", async () => {
  /** @type {[string, any][]} */
  const calls = [];
  const dir = nameDirectory(async (tool, input) => { calls.push([tool, input]); return { ok: true }; });
  const value = "Q2hhbGxlbmdlVmFsdWVfdGhhdF9pc19sb25n_x-1";
  await dir.acme("alex", value);
  await dir.acmeClear("alex");
  await dir.publish("alex");
  assert.deepEqual(calls, [["names.directory.acme", { token: value }], ["names.directory.acme-clear", {}], ["names.directory.publish", {}]]);
  assert.match(calls[0][1].token, /^[A-Za-z0-9_-]{20,128}$/, "the directory's own check for a challenge value");
});

test("name directory: publish carries `apps: true` only when the gate says the box has an app, and nothing otherwise", async () => {
  /** @type {[string, any][]} */
  const calls = [];
  const dir = nameDirectory(async (tool, input) => { calls.push([tool, input]); return { ok: true }; });
  await dir.publish("alex", { apps: true });
  await dir.publish("alex", { apps: false });
  await dir.publish("alex", /** @type {any} */ ({ apps: "yes" }));
  assert.deepEqual(calls, [["names.directory.publish", { apps: true }], ["names.directory.publish", {}], ["names.directory.publish", {}]]);
});
