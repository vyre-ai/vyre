// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../test/fake-dom.js";

install();
const { skeleton, loading, emptyState, errorState, whyFailed, SLOW_MS } = await import("./states.js");
const { empty } = await import("./dom.js");

test("a skeleton is rows at the real row height, hidden from assistive tech, with one busy label", () => {
  const el = skeleton(3);
  assert.equal($$(el, ".skel").length, 3);
  assert.equal(el.getAttribute("aria-busy"), "true");
  assert.equal($$(el, ".skel")[0].getAttribute("aria-hidden"), "true");
});

test("loading says it is slow after ten seconds, once, and stop() cancels it", () => {
  let fire = /** @type {any} */ (null), cleared = false;
  const el = loading({ setTimeout: /** @type {any} */ ((fn, ms) => { assert.equal(ms, SLOW_MS); fire = fn; return 7; }), clearTimeout: /** @type {any} */ (() => { cleared = true; }) });
  assert.equal($(el, ".kit-slow"), null);
  fire();
  assert.match(text($(el, ".kit-slow")), /slow to answer/);
  el.stop();
  assert.equal(cleared, true);
});

test("empty: one bold line, one sentence, one action; no picture", () => {
  const el = emptyState({ title: "Nothing is running", text: "Ask juno for something and it shows up here.", action: { label: "Ask juno", href: "/chat?new" } });
  assert.equal(text($(el, ".state-title")), "Nothing is running");
  assert.match(text($(el, ".state-text")), /Ask juno for something/);
  assert.equal($(el, "a").getAttribute("href"), "/chat?new");
  assert.equal($$(el, "img, svg").length, 0);
});

test("error: what failed, a quiet reason, Try again; the code is behind Copy details, not on the screen", () => {
  let tried = 0, copied = "";
  const el = errorState({ title: "Could not load what is running.", reason: "Vyre did not answer. Your work is safe.", retry: () => { tried++; }, details: "timeout: no answer", copy: t => { copied = t; } });
  assert.equal(el.getAttribute("role"), "alert");
  assert.match(text(el), /Could not load what is running\./);
  assert.doesNotMatch(text(el), /timeout: no answer/, "the real error is not drawn");
  $(el, "[data-act=retry]").click(); $(el, "[data-act=copy]").click();
  assert.equal(tried, 1); assert.equal(copied, "timeout: no answer");
});

test("whyFailed turns an ApiError into a plain reason and keeps the details", () => {
  assert.match(whyFailed({ missing: true, code: "offline", message: "x" }).reason, /Vyre did not answer/);
  assert.match(whyFailed({ missing: true, code: "no_such_tool", module: "planner" }).reason, /not running \(planner\)/);
  assert.match(whyFailed({ code: "bad_input", message: "name is required" }).reason, /name is required/);
  assert.equal(whyFailed({ code: "x", message: "y" }).details, "x: y");
});

test("empty() draws an error with its reason and a Try again only when the view can retry; a plain empty has neither", () => {
  assert.equal($(empty("Nothing here."), "button"), null);
  const bad = empty("Projects are not available.", { missing: true, module: "projects" }, () => {});
  assert.match(text(bad), /The projects module is not running/);
  assert.ok($(bad, "[data-act=retry]"));
  assert.equal($(empty("Projects are not available.", { message: "no" }), "button"), null);
});
