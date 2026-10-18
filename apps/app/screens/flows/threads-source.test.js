// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("a Flow's threads are asked for by Flow, and a box without the tool gives none", { skip: !strip }, async () => {
  const { threadsSource } = await import("./threads-source.ts");
  const seen = /** @type {any[]} */ ([]);
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input) => { seen.push([tool, input]); return { data: { threads: [{ id: "run_1", kind: "run", flow: "f1", state: "live" }, { nope: 1 }] } }; };
  assert.deepEqual((await threadsSource(ok).list("f1")).map((t) => t.id), ["run_1"]);
  assert.deepEqual(seen, [["work.flow.threads", { flow: "f1" }]]);
  const none = async () => ({ error: { code: "unknown_tool", message: "no such tool" } });
  assert.deepEqual(await threadsSource(none).list("f1"), []);
});
