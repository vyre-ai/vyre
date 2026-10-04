// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
/** @type {any} */ (globalThis).DOMParser = class { parseFromString() { return { documentElement: doc.createElement("svg") }; } };
const { starButton, REPO_URL } = await import("./star-button.js");

const tap = (btn, trusted = true) => btn.dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("click"), { isTrusted: trusted }));
function mount(answers) {
  const calls = [], opened = [];
  const attempt = async (tool, input = {}) => { calls.push([tool, input]); const a = answers[tool]; return a && a.$error ? { error: a.$error } : a === undefined ? { error: { missing: true } } : { data: a }; };
  const el = /** @type {any} */ (starButton({ attempt, open: u => opened.push(u) }));
  return { el, calls, opened };
}

test("not starred and connected: shown, no count, and one tap stars through the box then it is gone", async () => {
  const m = mount({ "github.star.status": { connected: true, starred: false }, "github.star": { starred: true } });
  assert.equal(m.el.hidden, true, "nothing while it is still asking");
  await m.el.ready;
  assert.equal(m.el.hidden, false);
  assert.doesNotMatch(text(m.el), /\d/, "no count");
  await tap($(m.el, "button")); await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(m.calls.map(c => c[0]), ["github.star.status", "github.star"]);
  assert.deepEqual(m.calls[1][1], {}, "the repo is the box's, never sent from here");
  assert.equal(m.el.hidden, true);
  assert.deepEqual(m.opened, []);
});

test("not connected: the tap opens the repo and stars nothing; already starred or a box without the tools shows nothing", async () => {
  const m = mount({ "github.star.status": { connected: false, starred: null } });
  await m.el.ready;
  assert.equal(m.el.hidden, false);
  tap($(m.el, "button"));
  assert.deepEqual(m.opened, [REPO_URL]);
  assert.equal(m.calls.filter(c => c[0] === "github.star").length, 0);
  for (const answers of [{ "github.star.status": { connected: true, starred: true } }, {}]) {
    const x = mount(answers); await x.el.ready;
    assert.equal(x.el.hidden, true);
  }
});

test("a click a script made does nothing; a refused star says why in words and stays", async () => {
  const m = mount({ "github.star.status": { connected: true, starred: false }, "github.star": { $error: { message: "The token needs the public_repo scope." } } });
  await m.el.ready;
  tap($(m.el, "button"), false);
  assert.equal(m.calls.filter(c => c[0] === "github.star").length, 0);
  assert.deepEqual(m.opened, []);
  await tap($(m.el, "button")); await new Promise(r => setTimeout(r, 5));
  assert.match(text(m.el), /public_repo scope/);
  assert.equal(m.el.hidden, false);
});
