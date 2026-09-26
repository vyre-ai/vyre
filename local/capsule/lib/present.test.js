// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { present } from "./present.js";

/** A window and an app that record what was asked of them, in order. */
function fakes() {
  const log = [];
  const rec = name => (...a) => { log.push([name, ...a]); };
  const w = /** @type {any} */ ({ show: rec("show"), showInactive: rec("showInactive"), focus: rec("focus"), setAlwaysOnTop: rec("setAlwaysOnTop"),
    setVisibleOnAllWorkspaces: rec("setVisibleOnAllWorkspaces"), webContents: { focus: rec("webContents.focus") } });
  const app = /** @type {any} */ ({ focus: rec("app.focus") });
  return { w, app, log };
}

test("present: today's way activates the app after the panel is shown, so typing reaches it over a normal app", () => {
  const { w, app, log } = fakes();
  present(w, app);
  assert.deepEqual(log.map(x => x[0]), ["show", "setAlwaysOnTop", "app.focus", "focus", "webContents.focus"]);
  assert.deepEqual(log[2], ["app.focus", { steal: true }]);
});

test("present: stay joins every Space again before showing, above full-screen windows, and never activates the app", () => {
  const { w, app, log } = fakes();
  present(w, app, { stay: true });
  assert.deepEqual(log[0], ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true, skipTransformProcessType: true }]);
  assert.deepEqual(log[1], ["setAlwaysOnTop", true, "screen-saver"]);
  assert.ok(log.findIndex(x => x[0] === "setVisibleOnAllWorkspaces") < log.findIndex(x => x[0] === "show"), "joined before it shows");
  assert.equal(log.filter(x => x[0] === "app.focus").length, 0, "no activation, so no Space switch");
  assert.ok(log.some(x => x[0] === "focus"), "the panel is still made key");
});

test("present: driven by a test it never takes the keyboard", () => {
  const { w, app, log } = fakes();
  present(w, app, { driven: true, stay: true });
  assert.equal(log.filter(x => ["show", "focus", "app.focus", "webContents.focus"].includes(x[0])).length, 0);
  assert.ok(log.some(x => x[0] === "showInactive"));
});
