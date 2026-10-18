// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "./once.js";

test("once runs the loader once and keeps its answer", () => {
  let runs = 0;
  const get = once(() => { runs++; return { a: 1 }; });
  assert.equal(get(), get());
  assert.equal(runs, 1);
});

test("a loader that throws fails the same way on every call, and is run again each time, never answering undefined", () => {
  let runs = 0;
  const get = once(() => { runs++; throw Object.assign(new Error("the data could not be read"), { code: "broken" }); });
  for (let i = 0; i < 2; i++) assert.throws(() => get(), (/** @type {any} */ e) => e.message === "the data could not be read" && e.code === "broken");
  assert.equal(runs, 2, "nothing was kept from the failed load");
  // a loader that fails first and then works answers once it can
  let ok = false;
  const later = once(() => { if (!ok) throw new Error("not yet"); return 7; });
  assert.throws(() => later(), /not yet/);
  ok = true;
  assert.equal(later(), 7);
});
