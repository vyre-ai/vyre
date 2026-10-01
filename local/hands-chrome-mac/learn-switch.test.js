// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createLearnSwitch } from "./learn-switch.js";

const sw = (/** @type {any} */ cfg, /** @type {any} */ call, /** @type {any} */ t = { n: 0 }) => ({ s: createLearnSwitch({ cfg, call, now: () => t.n }), t });

test("learning is on when the setting says so or is unset, and off when the person turned it off", async () => {
  for (const [reply, want] of [[{ data: { value: true } }, true], [{ data: {} }, true], [{ data: { value: false } }, false]]) {
    const { s } = sw({}, async () => reply);
    await s.refresh(); assert.equal(s.on(), want, JSON.stringify(reply));
  }
});

test("before the first read it is off; with no settings tool at all it is on; a failed read keeps the last answer", async () => {
  const a = sw({}, async () => ({ data: { value: true } }));
  assert.equal(a.s.on(), false, "nothing read yet");
  const b = sw({}, async () => ({ error: { code: "no_such_tool" } }));
  await b.s.refresh(); assert.equal(b.s.on(), true);
  const c = sw({}, async () => { throw new Error("hub down"); });
  await c.s.refresh(); assert.equal(c.s.on(), false, "a failed first read stays off");
  let calls = 0;
  const d = sw({}, async () => { calls++; if (calls > 1) throw new Error("hub down"); return { data: { value: true } }; });
  await d.s.refresh(); d.t.n += 20_000; await d.s.refresh();
  assert.equal(d.s.on(), true, "the last answer is kept");
});

test("the setting is re-read after 10 seconds and a change is seen", async () => {
  let v = true, calls = 0;
  const { s, t } = sw({}, async () => { calls++; return { data: { value: v } }; });
  await s.refresh(); await s.refresh(); assert.equal(calls, 1, "kept for 10 s");
  v = false; t.n += 11_000; await s.refresh();
  assert.equal(s.on(), false);
});

test("config learn wins and the setting is never read: false turns it off, a function is called", async () => {
  let calls = 0;
  const off = sw({ learn: false }, async () => { calls++; return { data: { value: true } }; });
  await off.s.refresh(); assert.equal(off.s.on(), false); assert.equal(calls, 0);
  let on = true;
  const fn = sw({ learn: () => on }, async () => ({}));
  assert.equal(fn.s.on(), true); on = false; assert.equal(fn.s.on(), false);
});
