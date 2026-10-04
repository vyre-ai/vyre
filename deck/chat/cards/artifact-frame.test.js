// @ts-check
// The frame guard (artifacts review M5) with a fake frame object, and the frame's fixed
// sandbox. Sample world only.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../../test/fake-dom.js";

install();
const { guardFrame, artifactFrame, SANDBOX, SANDBOX_STATIC, INTERACTIVE_LINE, interactiveByKind, NAVIGATED } = await import("./artifact-frame.js");

function fakeFrame() {
  /** @type {Record<string, (() => void)[]>} */ const on = {};
  const f = { attrs: /** @type {Record<string, string>} */ ({}), src: "/render/1",
    addEventListener(t, fn) { (on[t] ||= []).push(fn); },
    removeEventListener(t, fn) { on[t] = (on[t] || []).filter(x => x !== fn); },
    setAttribute(k, v) { f.attrs[k] = v; },
    fire() { for (const fn of [...(on.load || [])]) fn(); },
    listeners: () => (on.load || []).length };
  return f;
}

test("the first load is the artifact, and does not blank", () => {
  const f = fakeFrame(); let blanks = 0;
  const g = guardFrame(f, { onBlank: () => blanks++ });
  f.fire();
  assert.equal(g.loads(), 1);
  assert.equal(g.blanked(), false);
  assert.equal(blanks, 0);
  assert.equal(f.src, "/render/1");
});

test("a second load means it navigated: blank the frame and say so once", () => {
  const f = fakeFrame(); let blanks = 0;
  const g = guardFrame(f, { onBlank: () => blanks++ });
  f.fire(); f.fire();
  assert.equal(g.blanked(), true);
  assert.equal(f.src, "about:blank");
  assert.equal(f.attrs.src, "about:blank");
  assert.equal(blanks, 1);
  // The blank page's own load, and any later one, are ignored.
  f.fire(); f.fire();
  assert.equal(blanks, 1);
  assert.equal(g.loads(), 2);
});

test("stop() lets go of the frame and never blanks afterwards", () => {
  const f = fakeFrame(); let blanks = 0;
  const g = guardFrame(f, { onBlank: () => blanks++ });
  g.stop();
  assert.equal(f.listeners(), 0);
  f.fire(); f.fire(); f.fire();
  assert.equal(blanks, 0);
});

test("a frame with no onBlank still blanks", () => {
  const f = fakeFrame();
  guardFrame(f);
  f.fire(); f.fire();
  assert.equal(f.src, "about:blank");
});

test("the frame is sandbox=allow-scripts only, with the render route as src", () => {
  assert.equal(SANDBOX, "allow-scripts");
  const el = artifactFrame({ src: "/artifacts/a1/v2/render", title: "Quarterly report", interactive: true });
  const fr = $(el, "iframe");
  assert.equal(fr.getAttribute("sandbox"), "allow-scripts");
  assert.equal(fr.getAttribute("src"), "/artifacts/a1/v2/render");
  assert.equal(fr.getAttribute("title"), "Quarterly report");
  for (const bad of ["allow-same-origin", "allow-top-navigation", "allow-forms", "allow-popups"]) assert.ok(!fr.getAttribute("sandbox").includes(bad));
});

test("navigating replaces the frame with the plain line", () => {
  let blanks = 0;
  const el = /** @type {any} */ (artifactFrame({ src: "/artifacts/a1/v1/render", title: "Menu page", onBlank: () => blanks++ }));
  const fr = $(el, "iframe");
  fr.dispatchEvent(new Event("load"));
  assert.ok($(el, "iframe"));
  fr.dispatchEvent(new Event("load"));
  assert.equal($(el, "iframe"), null);
  assert.equal(text(el), NAVIGATED);
  assert.equal(NAVIGATED, "This page tried to open another site");
  assert.equal(blanks, 1);
});

test("a static kind runs no script (sandbox is empty); only interactive:true gets allow-scripts; nothing else is ever allowed", () => {
  const st = $(artifactFrame({ src: "/x", title: "Deck", interactive: false }), "iframe");
  assert.equal(SANDBOX_STATIC, "");
  assert.equal(st.getAttribute("sandbox"), "");
  assert.equal($(artifactFrame({ src: "/x", title: "Page", interactive: true }), "iframe").getAttribute("sandbox"), "allow-scripts");
  assert.equal(INTERACTIVE_LINE, "Runs its own code and can reach the internet");
  assert.deepEqual(["page", "app", "doc", "deck", "dashboard", "diagram", "image"].map(interactiveByKind), [true, true, false, false, false, false, false]);
});

test("interactive absent, or anything but true, runs no script; an unknown kind is never read as interactive", () => {
  for (const interactive of [undefined, false, /** @type {any} */ ("yes"), /** @type {any} */ (1)]) assert.equal($(artifactFrame({ src: "/x", title: "T", interactive }), "iframe").getAttribute("sandbox"), "");
  assert.equal(interactiveByKind("hologram"), false);
  assert.equal(interactiveByKind(""), false);
});
