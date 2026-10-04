// @ts-check
// js/glass-mini.js: one line per running agent computer on Now, from cohesion's sight (ADR 0036),
// following sight.stepped, with no polling and nothing for the Mac's own screen.

import "../../scripts/mac-test-guard.mjs";
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
  assert.equal(age(0, 3 * 86_400_000), "3 d");
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
  assert.deepEqual(asked, ["sight.targets", "sight.steps agent:kit", "sight.frame agent:kit"], "only the live agent's last step and still are read");
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

test("a server without sight shows nothing and is not asked again", async () => {
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

test("the card: a still of the screen, read again on each of its steps and never on a timer; the shield pauses it", async () => {
  /** @type {Record<string, any>} */
  const box = { "sight.targets": { targets: [{ target: "agent:kit", kind: "agent", live: true }] }, "sight.steps": { steps: [] } };
  let n = 0, shield = false;
  /** @type {any[]} */ const widths = [];
  box["sight.frame"] = (/** @type {any} */ i) => { n++; widths.push(i.maxWidth); return shield ? { $error: { code: "failed", message: "a person is signing in on kit's computer" } } : { image: "AAAA" + n, mime: "image/jpeg", at: n }; };
  /** @type {Map<string, Function>} */ const subs = new Map();
  const el = h("div", { hidden: true });
  mountGlassMini(el, {
    attempt: async (name, i) => { const a = typeof box[name] === "function" ? box[name](i) : box[name]; return a?.$error ? { error: a.$error } : { data: a }; },
    on: (type, fn) => { subs.set(type, fn); return () => {}; }, width: () => 640,
  });
  await tick(); await tick(); await tick();
  assert.equal(n, 1);
  assert.deepEqual(widths, [640]);
  const img = /** @type {any} */ (el.querySelector(".gm-frame img"));
  assert.equal(img.getAttribute("src"), "data:image/jpeg;base64,AAAA1");
  assert.equal(img.getAttribute("aria-hidden"), "true");
  assert.match(text(el), /Live/);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(n, 1, "no timer reads it again");
  subs.get("sight.stepped")?.({ payload: { target: "agent:kit", summary: "Opened Mail", ok: true, at: Date.now() } });
  await tick(); await tick();
  assert.equal(n, 2);
  shield = true;
  subs.get("sight.stepped")?.({ payload: { target: "agent:kit", summary: "Clicked Sign in", ok: true, at: Date.now() } });
  await tick(); await tick();
  assert.match(text(el), /Picture paused while a person signs in/);
  assert.doesNotMatch(text(el), /Live/);
  assert.ok(el.querySelector(".gm-frame.paused img"), "the last still stays, dimmed");
  shield = false;
  subs.get("computer.*")?.({ type: "computer.unshielded" });
  await tick(); await tick(); await tick();
  assert.match(text(el), /Live/);
  assert.doesNotMatch(text(el), /paused/);
});
