// @ts-check
// js/glass-mini.js: one line per running agent computer on Now, from cohesion's sight (ADR 0036),
// following sight.stepped, with no polling and nothing for the Mac's own screen.

import test from "node:test";
import assert from "node:assert/strict";
import { install, text, $$ } from "../test/fake-dom.js";

install();
const { agentOf, age, stepStatus, mountGlassMini } = await import("./glass-mini.js");
const { h } = await import("./dom.js");
const tick = () => new Promise(r => setTimeout(r, 0));

test("agentOf, age and stepStatus", () => {
  assert.equal(agentOf("agent:kit"), "kit");
  assert.equal(agentOf("mac"), null);
  assert.equal(age(1000, 2000), "now");
  assert.equal(age(0, 4000), "4 s");
  assert.equal(age(0, 120_000), "2 min");
  assert.equal(stepStatus({ ok: true, at: 0 }, true, 5000), "running");
  assert.equal(stepStatus({ ok: true, at: 0 }, true, 60_000), "done");
  assert.equal(stepStatus({ ok: false, at: 0 }, true, 1000), "failed");
  assert.equal(stepStatus(null, true, 0), "running");
});

test("a line per running agent computer, never the Mac; a step moves it; a stopped computer leaves", async () => {
  let t = 10_000;
  /** @type {Record<string, any>} */
  const box = {
    "sight.targets": { targets: [{ target: "mac", kind: "mac", label: "This Mac", live: true },
      { target: "agent:kit", kind: "agent", label: "kit", live: true }, { target: "agent:juno", kind: "agent", label: "juno", live: false }] },
    "sight.steps": { steps: [{ target: "agent:kit", action: "click", summary: "Clicked Compose in Mail", ok: true, at: 9_000 }] },
  };
  /** @type {string[]} */ const asked = [];
  /** @type {Map<string, Function>} */ const subs = new Map();
  const el = h("div", { hidden: true });
  const stop = mountGlassMini(el, {
    attempt: async (n, i) => { asked.push(n + (i?.target ? " " + i.target : "")); return { data: box[n] }; },
    on: (type, fn) => { subs.set(type, fn); return () => subs.delete(type); }, now: () => t,
  });
  await tick(); await tick();
  assert.deepEqual(asked, ["sight.targets", "sight.steps agent:kit"], "only the live agent's last step is read");
  assert.equal(el.hidden, false);
  const pills = $$(el, ".gm-pill");
  assert.equal(pills.length, 1);
  assert.equal(pills[0].getAttribute("href"), "/agents/kit/glass");
  assert.equal(pills[0].getAttribute("aria-label"), "Open Glass for kit's computer");
  assert.match(text(pills[0]), /kit.*Clicked Compose in Mail.*now/);
  t = 20_000;
  subs.get("sight.stepped")?.({ payload: { target: "agent:kit", action: "type", summary: "Typed the subject", ok: false, why: "the field was gone", at: 19_000 } });
  assert.match(text(el), /Typed the subject/);
  assert.match(text(el), /the field was gone/);
  assert.equal($$(el, ".sm-failed").length, 1);
  assert.match(text(el), /kit: Typed the subject/, "the live region says it");
  box["sight.targets"] = { targets: [{ target: "agent:kit", kind: "agent", live: false }] };
  subs.get("computer.*")?.({ type: "computer.stopped" });
  await tick(); await tick();
  assert.equal(el.hidden, true);
  stop();
});

test("a box without sight shows nothing and is not asked again", async () => {
  let n = 0;
  /** @type {Map<string, Function>} */ const subs = new Map();
  const el = h("div", { hidden: true });
  mountGlassMini(el, { attempt: async () => { n++; return { error: { code: "no_such_tool" } }; }, on: (type, fn) => { subs.set(type, fn); return () => {}; } });
  await tick();
  subs.get("computer.*")?.({});
  await tick();
  assert.equal(n, 1);
  assert.equal(el.hidden, true);
});
