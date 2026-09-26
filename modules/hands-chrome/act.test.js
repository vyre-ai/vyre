// @ts-check
// act, without a browser: perceive/decide/click are faked so FRESH BINDING and HALT DO NOT GUESS
// are testable without Chrome. The real path (a live DOM through cdp.js) is covered end to end
// in chrome.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as act from "./act.js";

/** @param {any[]} controls */
const snap = (controls, extra = {}) => ({ title: "t", url: "u", text: "", controls, ...extra });

test("act: clicks the control that re-binds by identity, not by the first look's index", async () => {
  const before = [{ path: "a[0]", role: "button", name: "Go", enabled: true, frame: { x: 0, y: 0, w: 10, h: 10 } }];
  // Between the first and second look, a banner pushed the same button down; only the frame moved.
  const after = [{ path: "a[1]", role: "button", name: "Go", enabled: true, frame: { x: 0, y: 40, w: 10, h: 10 } }];
  let look = 0;
  const clicks = [];
  const r = await act.once({
    request: { role: "button", name: "Go" },
    perceive: async () => snap(look++ === 0 ? before : after),
    decide: act.decideBySelector,
    click: async ctl => { clicks.push(ctl); },
  });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].path, "a[1]", "clicked the fresh binding, not the stale one");
  // verify.changed compares "after" (the post-look) against a further perceive() call, which in
  // this fake returns "after" again (look 2), so signatures match and the loop reports no change.
  assert.equal(r.ok, false);
});

test("act: refuses a consequential control before it is ever clicked", async () => {
  const send = { path: "a[0]", role: "button", name: "Send message", enabled: true, frame: { x: 0, y: 0, w: 10, h: 10 } };
  let clicked = false;
  const r = await act.once({
    request: { role: "button", name: "Send message" },
    perceive: async () => snap([send]),
    decide: act.decideBySelector,
    click: async () => { clicked = true; },
  });
  assert.equal(clicked, false);
  assert.equal(r.ok, false);
  assert.equal(r.consequential, true);
  assert.equal(r.retryable, false);
  assert.match(r.why, /take over in Glass/);
});

test("act: a control renamed to something consequential between the two looks is still refused", async () => {
  // An identifier is what lets the second look know this is the same element the first one
  // chose (selector.js weights it above name); without one, a renamed control simply fails to
  // re-bind, which is its own kind of safe. This is the case where identity survives the rename
  // and the new name must still be caught.
  const initial = { path: "a[0]", role: "button", identifier: "btn-1", name: "Save", enabled: true, frame: { x: 0, y: 0, w: 10, h: 10 } };
  const renamed = { path: "a[0]", role: "button", identifier: "btn-1", name: "Send", enabled: true, frame: { x: 0, y: 0, w: 10, h: 10 } };
  let look = 0, clicked = false;
  const r = await act.once({
    request: { role: "button", name: "Save" },
    perceive: async () => snap([look++ === 0 ? initial : renamed]),
    decide: act.decideBySelector,
    click: async () => { clicked = true; },
  });
  assert.equal(clicked, false, "must not click what was safe a moment ago and is not now");
  assert.equal(r.consequential, true);
});

test("act: two controls that match the request equally is a tie, not a guess", async () => {
  const a = { path: "a[0]", role: "button", name: "OK", enabled: true, frame: { x: 0, y: 0, w: 10, h: 10 } };
  const b = { path: "a[1]", role: "button", name: "OK", enabled: true, frame: { x: 0, y: 20, w: 10, h: 10 } };
  const r = await act.once({
    request: { role: "button", name: "OK" },
    perceive: async () => snap([a, b]),
    decide: act.decideBySelector,
    click: async () => { throw new Error("must not click a tie"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /matches/);
});

test("act: a disabled control is reported, not clicked", async () => {
  const off = { path: "a[0]", role: "button", name: "Cancel", enabled: false, frame: { x: 0, y: 0, w: 10, h: 10 } };
  const r = await act.once({
    request: { role: "button", name: "Cancel" },
    perceive: async () => snap([off]),
    decide: act.decideBySelector,
    click: async () => { throw new Error("must not click a disabled control"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /disabled/);
});

test("act: an observable click that changed the page reports ok with a diff", async () => {
  const before = { path: "a[0]", role: "button", name: "Go", enabled: true, frame: { x: 0, y: 0, w: 10, h: 10 } };
  const after = { ...before, name: "Go" };
  let look = 0;
  const r = await act.once({
    request: { role: "button", name: "Go" },
    perceive: async () => (look++ < 2 ? snap([before]) : snap([before], { title: "changed" })),
    decide: act.decideBySelector,
    click: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed.title.to, "changed");
  assert.equal(r.retryable, false, "a landed action is never retryable");
});

test("act: click stopping mid-turn (take-over) is reported without claiming anything happened", async () => {
  const ctl = { path: "a[0]", role: "button", name: "Go", enabled: true, frame: { x: 0, y: 0, w: 10, h: 10 } };
  const r = await act.once({
    request: { role: "button", name: "Go" },
    perceive: async () => snap([ctl]),
    decide: act.decideBySelector,
    click: async () => ({ ok: false, why: "glass:laptop has the keyboard" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /keyboard/);
});

test("act.run: stops after the repeat limit on a click that never lands", async () => {
  const ctl = { path: "a[0]", role: "button", name: "Go", enabled: true, frame: { x: 0, y: 0, w: 10, h: 10 } };
  const r = await act.run({
    request: { role: "button", name: "Go" },
    perceive: async () => snap([ctl]), // identical every time: verify.changed never sees a difference
    decide: act.decideBySelector,
    click: async () => {},
    limits: { repeats: 2, decisions: 10 },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /tried the same thing twice/);
});
