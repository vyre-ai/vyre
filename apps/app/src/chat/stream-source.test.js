// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { streamSource, stateOf } from "./stream-source.js";
import { createFolder } from "./frames.js";

test("the client's states map to the header's", () => {
  assert.equal(stateOf("live"), "live");
  assert.equal(stateOf("reconnecting"), "connecting");
  assert.equal(stateOf("resetting"), "connecting");
  assert.equal(stateOf("closed"), "offline");
});

test("connect passes from, open and frames through, and close reaches the client", () => {
  /** @type {any} */ let seen;
  let closed = 0;
  const src = streamSource({ connect: (o) => { seen = o; return { close: () => closed++ }; }, open: () => ({}) });
  const states = [];
  const frames = [];
  const h = src.connect({ from: 7, onFrame: (f) => frames.push(f), onState: (s) => states.push(s) });
  assert.equal(seen.from, 7);
  seen.onState("live");
  seen.onFrame({ cur: 8 });
  assert.deepEqual([states, frames.length], [["live"], 1]);
  h.close();
  assert.equal(closed, 1);
});

test("the folder takes core/stream's shapes: a diff block on file-changed, merged spans, reset with a head, heartbeat", () => {
  const f = createFolder();
  const base = { v: 1, id: "x", session: "s", turn: "t", time: 0, corr: "t" };
  f.apply({ ...base, cur: 1, type: "session.file-changed", data: { path: "a.ts", op: "edit", diff: { block: "diff", files: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] } } });
  assert.equal(f.item("f:1")?.block.block, "diff");
  const merged = f.apply({ ...base, cur: 5, span: 4, type: "session.text-delta", data: { message: "m", index: 0, text: "hello world" } });
  assert.equal(merged.gap, false, "a merged frame that starts at last + 1 is not a gap");
  assert.equal(f.apply({ ...base, cur: 0, type: "session.heartbeat", data: { head: 9 } }).dup, true);
  f.apply({ ...base, cur: 0, type: "session.text-delta", data: { message: "r", index: 0, text: "thinking", reasoning: true } });
  assert.equal(f.item("a:r"), null, "thinking is not drawn as a reply");
  const r = f.apply({ ...base, cur: 0, type: "session.reset", data: { reason: "old", head: 40 } });
  assert.equal(r.reset, true);
  assert.equal(f.last, 40);
  assert.equal(f.rows.length, 0);
});
