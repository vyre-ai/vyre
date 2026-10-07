// @ts-check
// A real vyred (kernel on): the stream is handed the sessions' kernel-session seam (calls on a thread's session and the restart's reopening), nobody else is, and it carries no way to
// open a session or to read a token. Then the stream's own start asks the seam to reopen the open turns. Real daemon, no assistant (the end-to-end turn is group-ks-live.test.js).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

test("a kernel-on vyred hands the stream the seam (forThread, reopenPending) and nobody else; there is no open and no token in it", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const mine = /** @type {any} */ (d.registry.context({ name: "stream", version: "0.1.0", does: { tools: [] }, needs: { daemon: ["kernelThreads"] } })).kernelThreads;
  assert.deepEqual(Object.keys(mine).sort(), ["forThread", "reopenPending"]);
  assert.equal(typeof mine.open, "undefined");
  assert.equal(typeof mine.tokenFor, "undefined");
  assert.equal(typeof /** @type {any} */ (d.registry.context({ name: "other", version: "0.1.0", does: { tools: [] } })).kernelThreads, "undefined", "and nobody else");
  // a thread with no session: every call says so, and none returns a token
  const s = mine.forThread("thr_none");
  assert.deepEqual(Object.keys(s).sort(), ["append", "appendOpen", "beginTurn", "roomFor"]);
  await assert.rejects(() => s.beginTurn(), /** @param {any} e */ e => e.code === "no_session");
  await assert.rejects(() => s.appendOpen({ kind: "text" }), /** @param {any} e */ e => e.code === "no_session");
  // nothing was kept to reopen, so the restart's reopening resolves empty
  assert.deepEqual(await mine.reopenPending({ timeoutMs: 1000 }), { resumed: [], gaveUp: [] });
});
