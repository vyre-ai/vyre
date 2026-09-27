// @ts-check
// write(): one intent, one key, retried through a vyred restart (ADR 0029, R2).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tempHome, writeModule } from "../../test/helpers.js";
import { start } from "./index.js";
import { write } from "./client.js";

function counter(root) {
  writeModule(path.join(root, "modules"), "count", { does: { tools: ["count.add"] }, watches: { emits: ["count.added"] } }, `export default { async start(ctx) {
    ctx.tool("count.add", { input: { type: "object", properties: { n: { type: "number" } } }, run: async i => { ctx.events.emit("count.added", { n: i.n }); return { n: i.n }; } });
    return {};
  } };`);
}

test("write: a send made while vyred is restarting lands once when it is back", { timeout: 30_000 }, async t => {
  const root = tempHome(t);
  counter(root);
  let d = await start({ root, log: () => {} });
  t.after(async () => { await d.stop(); });
  await d.stop();
  const pending = write("count.add", { n: 1 }, { root, key: "key-restart-1", caller: "cli" });
  await new Promise(r => setTimeout(r, 600));
  d = await start({ root, log: () => {} });
  const r = await pending;
  assert.deepEqual(r.data, { n: 1 });
  // The same intent again (a retry after a lost answer) is the first answer, not a second write.
  const again = await write("count.add", { n: 1 }, { root, key: "key-restart-1", caller: "cli" });
  assert.equal(/** @type {any} */ (again).replayed, true);
  assert.equal(d.events.since(0, { type: "count.added", limit: 10 }).length, 1);
});

test("write: gives up after its patience and says vyred is unreachable", { timeout: 10_000 }, async t => {
  const root = tempHome(t);
  const r = await write("count.add", { n: 1 }, { root, patience: 700 });
  assert.equal(r.error?.code, "unreachable");
});
