// One records world shared by every screen: one read at a time, a write re-reads its type only, a burst of box events reads once, a second screen shares what the first has.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOON_MS, createShare } from "./world-share.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function world() {
  /** @type {string[]} */ const asked = [];
  /** @type {(() => void)[]} */ const timers = [];
  let n = 0;
  const share = createShare({
    readAll: async () => { asked.push("all"); n++; return { n, types: [{ name: "contact" }, { name: "deal" }], byType: { contact: [`c${n}`], deal: [`d${n}`] } }; },
    readTypes: async (prev, types) => { asked.push(types.join(",")); return { ...prev, byType: { ...prev.byType, ...Object.fromEntries(types.map((t) => [t, [`${t}-again`]])) } }; },
    has: (w, t) => w.types.some((/** @type {any} */ x) => x.name === t),
    wait: (f, ms) => { assert.equal(ms, SOON_MS); timers.push(f); },
  });
  return { share, asked, timers };
}

test("the first screen reads the world; a second screen shares it and reads nothing", async () => {
  const { share, asked } = world();
  assert.equal(share.state().loading, true);
  const off1 = share.subscribe(() => {});
  await tick(); await tick();
  assert.deepEqual(asked, ["all"]);
  assert.equal(share.state().data.n, 1);
  const off2 = share.subscribe(() => {});
  await tick();
  assert.deepEqual(asked, ["all"], "the record panel and the Access tab draw from the same world");
  off1(); off2();
  share.subscribe(() => {});
  await tick(); await tick();
  assert.deepEqual(asked, ["all", "all"], "back after none: the kept world draws and is read again behind it");
  assert.equal(share.state().loading, false, "and never shows loading again");
});

test("a write names its type: only that type is read; a type the world does not show is nothing to read", async () => {
  const { share, asked } = world();
  share.subscribe(() => {});
  await tick(); await tick();
  share.changed({ type: "deal" });
  await tick(); await tick();
  assert.deepEqual(asked, ["all", "deal"]);
  assert.deepEqual(share.state().data.byType, { contact: ["c1"], deal: ["deal-again"] }, "the other types stand as they were");
  share.changed({ type: "chat" });
  await tick(); await tick();
  assert.deepEqual(asked, ["all", "deal"], "a hidden or unknown type reads nothing");
  share.changed(undefined);
  await tick(); await tick();
  assert.deepEqual(asked, ["all", "deal", "all"], "no hint: anything may have changed");
});

test("changes during a read run once after it, gathered; a burst of box events reads once after a pause", async () => {
  const { share, asked, timers } = world();
  share.subscribe(() => {});
  share.changed({ type: "deal" }); share.changed({ type: "contact" }); share.changed({ type: "deal" });
  await tick(); await tick(); await tick();
  assert.deepEqual(asked, ["all", "deal,contact"], "an import of many rows is one read after, not one per row");
  for (let i = 0; i < 20; i++) share.changed({ soon: true });
  assert.equal(timers.length, 1, "twenty events, one wait");
  timers[0]();
  await tick(); await tick();
  assert.deepEqual(asked, ["all", "deal,contact", "all"]);
});

test("a failed read keeps the last world and says why", async () => {
  let fail = false;
  const share = createShare({
    readAll: async () => { if (fail) throw new Error("the box did not answer"); return { types: [], byType: {} }; },
    readTypes: async (p) => p, has: () => false, wait: () => {},
  });
  share.subscribe(() => {});
  await tick(); await tick();
  fail = true;
  await share.reload();
  assert.ok(share.state().data, "the last world stands");
  assert.equal(share.state().error?.message, "the box did not answer");
});
