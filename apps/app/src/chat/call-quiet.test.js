import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { callQuiet, threadOrSkip } from "./call-quiet.js";

test("a chat id is not a thread id, and a failed call waits longer each time", async () => {
  assert.equal(threadOrSkip("", "chat_1"), null);
  assert.equal(threadOrSkip("chat_1", "chat_1"), null);
  assert.equal(threadOrSkip("th_quiet", "chat_1"), "th_quiet");

  let n = 0;
  const first = await callQuiet("threads.tasks:th_quiet", async () => { n += 1; throw new Error("no thread"); }, 1_000);
  assert.deepEqual(first, { skipped: false, ok: false });
  assert.equal(n, 1);
  const during = await callQuiet("threads.tasks:th_quiet", async () => { n += 1; return 1; }, 1_000 + 1_999);
  assert.equal(during.skipped, true);
  assert.equal(n, 1, "a remount inside the wait does not call again");
  const second = await callQuiet("threads.tasks:th_quiet", async () => { n += 1; throw new Error("no thread"); }, 1_000 + 2_000);
  assert.equal(second.ok, false);
  assert.equal(n, 2);
  const still = await callQuiet("threads.tasks:th_quiet", async () => 1, 3_000 + 7_999);
  assert.equal(still.skipped, true, "the second failure waits eight seconds");
  const back = await callQuiet("threads.tasks:th_quiet", async () => 7, 3_000 + 8_000);
  assert.deepEqual(back, { skipped: false, ok: true, value: 7 });
  const again = await callQuiet("threads.tasks:th_quiet", async () => 8, 0);
  assert.equal(again.ok && again.value, 8, "a success clears the wait");
});
