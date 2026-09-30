// @ts-check
// The frame guard (artifacts review M5) with a fake frame object, and the frame's fixed
// sandbox. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../../test/fake-dom.js";

install();
const { guardFrame, artifactFrame, SANDBOX, NAVIGATED } = await import("./artifact-frame.js");

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
  const el = artifactFrame({ src: "/artifacts/a1/v2/render", title: "Quarterly report" });
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

// ---- the per-render nonce (reviewer-2 M2) ---------------------------------------------------------
const wait = ms => new Promise(r => setTimeout(r, ms));
/** The parent hearing a message from a window. */
function post(source, data) { for (const fn of [...(msgs.get(globalThis) || [])]) fn({ source, data }); }
const msgs = new Map();
{
  const add = globalThis.addEventListener?.bind(globalThis), rm = globalThis.removeEventListener?.bind(globalThis);
  globalThis.addEventListener = (t, fn, o) => { if (t === "message") { (msgs.get(globalThis) || msgs.set(globalThis, []).get(globalThis)).push(fn); return; } add?.(t, fn, o); };
  globalThis.removeEventListener = (t, fn, o) => { if (t === "message") { msgs.set(globalThis, (msgs.get(globalThis) || []).filter(x => x !== fn)); return; } rm?.(t, fn, o); };
}
const win = {};

test("nonce: a first load with no message inside the wait blanks (a page that navigated before its first load)", async () => {
  const f = /** @type {any} */ (fakeFrame()); f.contentWindow = win; let blanks = 0;
  const g = guardFrame(f, { nonce: "n1", wait: 20, onBlank: () => blanks++ });
  f.fire();
  assert.equal(g.blanked(), false, "not yet: the message may still be on its way");
  await wait(40);
  assert.equal(g.blanked(), true);
  assert.equal(f.attrs.src, "about:blank");
  assert.equal(blanks, 1);
  g.stop();
});

test("nonce: the page posting its nonce keeps the frame; a later load still blanks", async () => {
  const f = /** @type {any} */ (fakeFrame()); f.contentWindow = win; let blanks = 0;
  const g = guardFrame(f, { nonce: "n2", wait: 20, onBlank: () => blanks++ });
  f.fire();
  post(win, { vyreFrame: "n2" });
  await wait(40);
  assert.equal(g.heard(), true);
  assert.equal(g.blanked(), false);
  f.fire();
  assert.equal(g.blanked(), true, "a navigation after the message");
  g.stop();
});

test("nonce: a message before the load, from another window, or with another nonce does not count", async () => {
  const f = /** @type {any} */ (fakeFrame()); f.contentWindow = win;
  const g = guardFrame(f, { nonce: "n3", wait: 20 });
  post({}, { vyreFrame: "n3" });
  post(win, { vyreFrame: "other" });
  post(win, "n3");
  assert.equal(g.heard(), false);
  post(win, { vyreFrame: "n3" });
  f.fire();
  await wait(40);
  assert.equal(g.blanked(), false, "heard before its load event: fine");
  g.stop();
});

test("no nonce: counted the old way, a first load alone never blanks", async () => {
  const f = /** @type {any} */ (fakeFrame()); const g = guardFrame(f, { wait: 10 });
  f.fire(); await wait(30);
  assert.equal(g.blanked(), false);
});

test("artifactFrame with a nonce asks the route for it as ?n=", () => {
  const w = /** @type {any} */ (artifactFrame({ src: "/artifacts/a1/v1/render", title: "Menu", nonce: "abc123" }));
  assert.equal($(w, "iframe").getAttribute("src"), "/artifacts/a1/v1/render?n=abc123");
  w.guard.stop();
  const plain = /** @type {any} */ (artifactFrame({ src: "/artifacts/a1/v1/render", title: "Menu" }));
  assert.equal($(plain, "iframe").getAttribute("src"), "/artifacts/a1/v1/render");
});
