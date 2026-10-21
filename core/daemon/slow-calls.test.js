// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { timeCalls } from "./slow-calls.js";

test("slow calls: a call over the limit is logged by tool and time, and its answer or error is unchanged", async () => {
  let t = 0;
  const logged = /** @type {string[]} */ ([]);
  const reg = { n: 0, async call(/** @type {string} */ tool, /** @type {any} */ input) { this.n++; t += input.takes; if (input.boom) throw new Error("boom"); return { data: tool }; } };
  timeCalls(reg, m => logged.push(m), { now: () => t });
  assert.deepEqual(await reg.call("files.list", { takes: 100 }), { data: "files.list" });
  assert.deepEqual(logged, []);
  assert.deepEqual(await reg.call("threads.send", { takes: 2600 }), { data: "threads.send" });
  assert.deepEqual(logged, ["warn: slow call threads.send took 2600 ms"]);
  await assert.rejects(reg.call("mail.send", { takes: 3000, boom: true }), /boom/);
  assert.equal(logged.length, 2);
  assert.equal(reg.n, 3, "this is still the same registry");
});
